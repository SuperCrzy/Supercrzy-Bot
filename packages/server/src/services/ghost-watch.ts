/**
 * 幽灵模式（Ghost Mode）— 环境感知服务
 * 监控工作区文件变化 → 轻量评估是否值得介入 → 生成预判建议
 * 设计原则：低打扰——只在高置信度时建议，同文件限频，绝不刷存在感
 */
import { watch, type FSWatcher } from 'fs'
import { readFile } from 'fs/promises'
import { join, resolve, extname, basename } from 'path'
import { config } from '../config'

/** 监控根目录：项目根（packages/server → supercrzy-agent） */
const WATCH_ROOT = resolve(config.workspaceDir, '../..')

/** 忽略目录：构建产物 / 依赖 / 版本控制 / 数据 */
const IGNORED = [
  'node_modules', '.git', 'dist', 'data', 'uploads', '.workbuddy',
  'coverage', '.pnpm-store', 'tmp',
]

/** 只评估这些文件类型（代码/文档/配置），避免噪音 */
const INTERESTING_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.vue', '.py', '.json', '.md',
  '.css', '.html', '.yaml', '.yml', '.sh', '.sql', '.txt',
])

interface GhostSuggestion {
  id: string
  time: string
  file: string
  type: 'created' | 'modified' | 'deleted'
  reason: string
  suggestion: string
  confidence: number
  executed: boolean
}

// ---- 状态 ----
let enabled = true
let watcher: FSWatcher | null = null
const suggestions: GhostSuggestion[] = []
/** 最近评估时间（限频） */
let lastEvalAt = 0
/** 防抖缓冲：文件路径 → 最后事件 */
const pendingEvents = new Map<string, { type: string; mtime: number }>()
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let evalSeq = 0

const MIN_EVAL_INTERVAL = 60_000   // 两次评估至少间隔 60s
const SAME_FILE_COOLDOWN = 5 * 60_000  // 同文件 5 分钟内不重复建议
const MAX_SUGGESTIONS = 20

function shouldIgnore(absPath: string): boolean {
  if (absPath.startsWith('.')) return false
  const parts = absPath.split('/')
  return parts.some((p) => IGNORED.includes(p))
}

export function startGhostWatcher(): void {
  if (watcher) return
  try {
    watcher = watch(WATCH_ROOT, { recursive: true }, (eventType, filename) => {
      if (!enabled || !filename) return
      const abs = resolve(WATCH_ROOT, filename.toString())
      if (shouldIgnore(abs)) return
      const ext = extname(abs).toLowerCase()
      if (!INTERESTING_EXT.has(ext)) return

      pendingEvents.set(abs, { type: eventType, mtime: Date.now() })
      if (!debounceTimer) {
        debounceTimer = setTimeout(() => {
          debounceTimer = null
          flushEvents()
        }, 15_000)  // 15s 防抖聚合
      }
    })
    console.log(`[Ghost] 幽灵模式已启动，监控: ${WATCH_ROOT}`)
  } catch (err: any) {
    console.warn(`[Ghost] 监控启动失败(降级为不可用): ${err.message}`)
  }
}

async function flushEvents() {
  if (pendingEvents.size === 0) return
  console.log(`[Ghost] flushEvents: ${pendingEvents.size} 个事件, 距上次评估 ${Math.round((Date.now() - lastEvalAt) / 1000)}s`)
  if (Date.now() - lastEvalAt < MIN_EVAL_INTERVAL) {
    pendingEvents.clear()
    return
  }

  const events = Array.from(pendingEvents.entries())
    .sort((a, b) => a[1].mtime - b[1].mtime)
    .slice(-6)  // 最多评估最近 6 个变化
  pendingEvents.clear()
  lastEvalAt = Date.now()

  await evaluate(events)
}

async function evaluate(events: Array<[string, { type: string; mtime: number }]>) {
  const db = await import('./database').then((m) => m.getDB())
  const fileList = events.map(([p, e]) => `${e.type === 'rename' ? '变更' : e.type} ${p.replace(WATCH_ROOT, '~')}`).join('\n')

  // 读取最近变更文件的内容片段（前 400 字符），让评估有依据
  const contents: string[] = []
  for (const [p] of events) {
    try {
      const content = await readFile(p, 'utf-8')
      contents.push(`${p.replace(WATCH_ROOT, '~')}:\n${content.slice(0, 400)}`)
    } catch { /* 文件可能已被删除 */ }
  }
  const contentBlock = contents.length > 0 ? `\n\n文件内容片段：\n${contents.join('\n---\n')}` : ''
  const recentSuggest = suggestions[0]

  const prompt = `你是 SUPERCRZY 的"幽灵模式"——一个克制、专业的观察者。你注意到用户最近改了这些文件：

${fileList}${contentBlock}

最近一条建议（避免重复）：${recentSuggest ? `[${recentSuggest.file}] ${recentSuggest.suggestion}` : '(无)'}

判断规则：
1. 只有当变化明显值得介入时才建议（例如：出现报错迹象、重复模式、明显的可优化点、或用户连续改动同一文件可能陷入困境）。
2. 不要对普通编辑、格式调整、增删字段等琐碎变化建议——那会打扰用户。
3. **硬编码密钥/凭证（如 sk- 开头的 API Key）出现在源码中时，shouldSuggest 必须为 true**——这是必须提醒的安全问题。
4. 如果值得，给出一条具体、可执行的建议（≤50字，中文）。

严格输出 JSON（不要其他文字）：
{"shouldSuggest": true或false, "reason": "判断理由(≤30字)", "suggestion": "具体建议(≤50字)", "confidence": 0到1的数字}`

  try {
    // key 读取回退链：settings → custom_providers(deepseek) → .env
    const keyRow = db.prepare("SELECT value FROM settings WHERE key='apiKey'").get() as { value?: string } | undefined
    let apiKey = keyRow?.value || ''
    if (!apiKey) {
      const cp = db.prepare("SELECT api_key FROM custom_providers WHERE provider_key='deepseek'").get() as { api_key?: string } | undefined
      apiKey = cp?.api_key || ''
    }
    if (!apiKey) apiKey = config.deepseek.apiKey || ''
    console.log(`[Ghost] 评估开始, key: ${apiKey ? '有' : '无'}`)
    const resp = await fetch(`${normalizeBaseUrl(config.deepseek.baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.4,
      }),
    })
    console.log(`[Ghost] 评估 HTTP ${resp.status}`)
    if (!resp.ok) return
    const data = await resp.json() as any
    const text = data.choices?.[0]?.message?.content || ''
    console.log(`[Ghost] 评估响应: ${text.slice(0, 120)}`)
    if (!text) return
    let parsed: any = null
    try { parsed = JSON.parse(text.replace(/```json|```/g, '').trim()) }
    catch {
      const m = text.match(/\{[\s\S]*\}/)
      if (m) { try { parsed = JSON.parse(m[0]) } catch {} }
    }
    if (!parsed) return

    const confidence = Number(parsed.confidence) || 0
    if (parsed.shouldSuggest && confidence >= 0.6) {
      const file = events[events.length - 1][0]
      const suggestionText = String(parsed.suggestion || '').slice(0, 200)
      if (!suggestionText) return

      // 同文件冷却：5 分钟内不重复
      const now = Date.now()
      const dup = suggestions.find((s) => s.file === file && now - new Date(s.time).getTime() < SAME_FILE_COOLDOWN)
      if (dup) return

      suggestions.unshift({
        id: `ghost_${Date.now()}_${evalSeq++}`,
        time: new Date().toISOString(),
        file,
        type: 'modified',
        reason: String(parsed.reason || '').slice(0, 60),
        suggestion: suggestionText,
        confidence,
        executed: false,
      })
      if (suggestions.length > MAX_SUGGESTIONS) suggestions.pop()
      console.log(`[Ghost] 建议: ${suggestionText.slice(0, 50)}...`)
    }
  } catch { /* 评估失败静默 */ }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, '')
}

export function getGhostSuggestions() {
  return suggestions
}

export function setGhostEnabled(v: boolean) {
  enabled = v
}

export function isGhostEnabled() {
  return enabled
}

export function markGhostExecuted(id: string) {
  const s = suggestions.find((x) => x.id === id)
  if (s) s.executed = true
}

export function stopGhostWatcher() {
  watcher?.close()
  watcher = null
}
