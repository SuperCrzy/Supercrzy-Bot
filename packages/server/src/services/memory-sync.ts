// 记忆 sync_turn（Hermes 式 turn 后同步）—— 任务完成后 LLM 判断对话中是否有值得长期记忆的信息，
// 写入 agent_memory（用户偏好/项目事实/关键决定）。与规则式 autoExtractMemories 互补，覆盖范围更广。
// 配合 buildSystemPrompt 的 FTS5 语义预取（prefetch）→ 构成 Hermes 式"turn 前预取 + turn 后同步"闭环

import { config } from '../config/index.js'
import { getDB } from './database.js'
import { randomUUID } from 'crypto'

function readSetting(key: string): string {
  try {
    const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row?.value ? String(row.value).trim() : ''
  } catch {
    return ''
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, '')
}

async function llmJson(system: string, user: string, fallback: unknown): Promise<any> {
  const apiKey = readSetting('apiKey') || config.deepseek.apiKey
  if (!apiKey) return fallback
  const model = readSetting('model') || config.deepseek.defaultModel
  const baseUrl = normalizeBaseUrl(readSetting('baseUrl') || config.deepseek.baseUrl)
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: `${system}\n\n你只能输出一个合法的 JSON 对象，不要输出任何其他文字，不要用代码块围栏。` },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`LLM ${resp.status}: ${errText.slice(0, 150)}`)
  }
  const data = await resp.json() as any
  const text = data?.choices?.[0]?.message?.content || ''
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    if (parsed && typeof parsed === 'object') return parsed
    throw new Error('non-object')
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (m) {
      try { return JSON.parse(m[0]) } catch { /* fallthrough */ }
    }
    return fallback
  }
}

const SYNC_SYSTEM = `You are a memory curator for an AI agent. After a conversation turn, decide whether the exchange contains facts worth remembering long-term: user preferences, personal facts, project facts, or important decisions. Be conservative — only extract durable, reusable information, not one-off task details.`

const VALID_CATEGORIES = new Set(['user', 'knowledge', 'general'])

/**
 * turn 后记忆同步：LLM 从本次对话提取值得长期记住的信息（最多 3 条）写入 agent_memory
 * 同 key 已存在 → 更新 content；不存在 → 插入。importance 冲突取较高值。
 */
export async function syncTurnMemories(userContent: string, assistantContent: string): Promise<void> {
  // 简单问候/极短内容不触发
  if (userContent.length < 4 || assistantContent.length < 20) return
  const memoryEnabledRow = getDB().prepare('SELECT value FROM settings WHERE key = ?').get('memoryEnabled') as any
  if (memoryEnabledRow && memoryEnabledRow.value !== 'true') return

  const user = `<user>${userContent.slice(0, 1500)}</user>
<assistant>${assistantContent.slice(0, 2500)}</assistant>

Extract 0-3 durable memories worth storing long-term. Categories:
- "user": user preferences, personal facts, identity (我叫/我喜欢/我在做X)
- "knowledge": project facts, technical decisions, domain facts stated with confidence
- "general": anything else durable
Rules: skip task-specific details, skip obvious content, skip anything already covered by the exchange itself. Prefer short keys.
Return JSON: {"memories": [{"key": "简短键名(中文)", "content": "一句话事实", "category": "user|knowledge|general", "importance": 5}]}`

  let memories: Array<{ key: string; content: string; category: string; importance: number }> = []
  try {
    const res = await llmJson(SYNC_SYSTEM, user, { memories: [] })
    memories = (Array.isArray(res.memories) ? res.memories : []).slice(0, 3)
      .filter((m: any) => m?.key && m?.content)
      .map((m: any) => ({
        key: String(m.key).slice(0, 60),
        content: String(m.content).slice(0, 300),
        category: VALID_CATEGORIES.has(String(m.category)) ? String(m.category) : 'general',
        importance: Math.min(Math.max(parseInt(m.importance) || 5, 1), 10),
      }))
  } catch (e: any) {
    console.log(`[MemorySync] LLM 提取失败: ${e?.message || e}`)
    return
  }
  if (memories.length === 0) return

  const db = getDB()
  const now = new Date().toISOString()
  let added = 0
  for (const m of memories) {
    const existing = db.prepare('SELECT id, importance FROM agent_memory WHERE key = ?').get(m.key) as any
    if (existing) {
      db.prepare('UPDATE agent_memory SET content = ?, importance = MAX(importance, ?), updated_at = ? WHERE id = ?')
        .run(m.content, m.importance, now, existing.id)
    } else {
      db.prepare('INSERT INTO agent_memory (id, key, content, category, importance, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), m.key, m.content, m.category, m.importance, 0.5, now, now)
      added++
    }
  }
  if (added > 0) console.log(`[MemorySync] 新增 ${added} 条记忆（共 ${memories.length} 条候选）`)
}
