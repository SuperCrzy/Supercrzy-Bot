/**
 * Agent Loop 核心逻辑
 * 实现智能体的自主决策循环：思考 → 行动 → 观察 → 思考 ...
 *
 * P0 改造：
 * - 动态 maxTurns：根据任务复杂度 10~60 轮弹性伸缩
 * - 中间检查点：每 N 轮落盘状态，超限可从检查点续跑
 * - Planner 模式：复杂任务先规划再执行
 */
import { randomUUID } from 'crypto'
import os from 'os'
import { join } from 'path'
import { writeFile, mkdir, appendFile } from 'fs/promises'
import { existsSync, readdirSync } from 'fs'
import type { Context } from 'koa'
import { config } from '../config'
import { rankMemories, memoryRankedSearch } from './memory-search'
import { requestChat, chatCompletion, normalizeBaseUrl } from './model-client'
import { getDB } from '../services/database'
import { toolDefinitions, executeToolCalls, type ToolCall, type ToolResultWithMeta, getToolMeta, type ToolExecCtx } from './tools'
import { pushMemorySync, pushReflection } from './memory-worker'

// ---- 敏感工具确认机制（先确认后执行）----
const pendingConfirmations = new Map<string, (decision: 'allow' | 'deny') => void>()

// 工具流式输出累计字节（按 toolCallId 计数，防单工具输出刷爆死循环）
const toolStreamBytes = new Map<string, number>()

// 会话级授权：用户点过"本会话全部允许"后，该会话内所有敏感工具自动放行（除 file_delete 永远确认）。
// 2026-08-26 修复：① 语义由"单个工具"改为"整会话所有敏感工具"（不再按 toolName 记，否则后续不同工具仍要询问）；
// ② 从"进程内存 Set"改为**持久化到 settings 表**（key=sessionAllowedIds，JSON 数组），服务重启后仍保持。
const sessionApprovedTools = new Set<string>()
let sessionApprovalsLoaded = false

function loadSessionApprovals() {
  if (sessionApprovalsLoaded) return
  sessionApprovalsLoaded = true
  try {
    const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get('sessionAllowedIds') as any
    if (row?.value) {
      const ids: unknown = JSON.parse(row.value)
      if (Array.isArray(ids)) ids.filter(Boolean).forEach(id => sessionApprovedTools.add(String(id)))
    }
  } catch { /* settings 无该键或损坏则忽略 */ }
}

function persistSessionApprovals() {
  try {
    getDB()
      .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('sessionAllowedIds', ?, datetime('now'))")
      .run(JSON.stringify(Array.from(sessionApprovedTools)))
  } catch { /* 持久化失败不阻塞授权 */ }
}

/** 本会话全部允许：记录整会话（忽略 toolName），后续该会话任何敏感工具均自动放行（file_delete 除外）。持久化跨重启。 */
export function approveSessionTools(sessionId: string, toolName?: string) {
  if (!sessionId) return
  loadSessionApprovals()
  sessionApprovedTools.add(sessionId)
  persistSessionApprovals()
}

export function revokeSessionApproval(sessionId: string) {
  loadSessionApprovals()
  if (sessionApprovedTools.delete(sessionId)) persistSessionApprovals()
}

export function resolveToolConfirmation(id: string, decision: 'allow' | 'deny') {
  pendingConfirmations.get(id)?.(decision)
  pendingConfirmations.delete(id)
}

function waitForToolConfirmation(id: string, timeoutMs = 120000): Promise<'allow' | 'deny'> {
  // 自动允许等待（设置 toolAutoApproveSeconds：>0 秒后无人确认自动放行；0=关闭，保持超时拒绝兜底）
  let autoSec = 0
  try { autoSec = Number(readSetting('toolAutoApproveSeconds') || 0) } catch { autoSec = 0 }
  const autoAllow = autoSec > 0
  const effective = autoAllow ? autoSec * 1000 : timeoutMs
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirmations.delete(id)
      resolve(autoAllow ? 'allow' : 'deny')
    }, effective)
    pendingConfirmations.set(id, (d) => { clearTimeout(timer); resolve(d) })
  })
}

// ---- AskQuestion：Agent 结构化提问（学 Grok AskQuestion 工具）----
const pendingQuestions = new Map<string, (answer: string) => void>()

/** 前端回复提问（chat.ts 路由调用） */
export function resolveQuestion(id: string, answer: string) {
  pendingQuestions.get(id)?.(answer)
  pendingQuestions.delete(id)
}

/** Agent 提问：挂起等待用户选项/输入答复（10 分钟超时自动取消） */
function waitForQuestion(id: string, timeoutMs = 600000): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingQuestions.delete(id)
      resolve('__timeout__')
    }, timeoutMs)
    pendingQuestions.set(id, (a) => { clearTimeout(timer); resolve(a) })
  })
}

/** 提问 options 归一化为字符串数组（2026-08-27 加：模型可能传对象数组/嵌套结构，防前端渲染 [object Object]） */
function normalizeQuestionOptions(options: any): string[] {
  if (!Array.isArray(options)) return options ? [String(options)] : []
  return options.map((o: any) => {
    if (typeof o === 'string') return o
    if (o == null) return ''
    if (typeof o === 'object') return String(o.text ?? o.label ?? o.value ?? JSON.stringify(o))
    return String(o)
  }).filter(Boolean)
}

/**
 * 工具消息序列清洗（2026-08-28 修复 400 "assistant tool_calls 后缺 tool 消息"）：
 * OpenAI 兼容协议要求 assistant 带 tool_calls 后，每个 tool_call_id 必须有对应 tool 消息。
 * 孤立 tool_calls 来源：①检查点恢复残缺 ②上下文压缩丢弃 tool 响应 ③工具超时/中断（assistantMsg 已 push 但 tool 结果不全）。
 * 策略：发请求前扫描，若 assistant.tool_calls 中某 id 未被后续 tool 消息响应 → 剔除该 tool_calls（防 400）。
 */
export function sanitizeToolCallSequence(msgs: AgentMessage[]): AgentMessage[] {
  const out: AgentMessage[] = []
  let pendingIds = new Set<string>()  // 当前待配对的 tool_call_id（来自最近一条 assistant.tool_calls）
  const pendingAssistant: AgentMessage | null = null  // eslint-disable-line (占位,避免误删)

  for (const m of msgs) {
    if (m.role === 'assistant' && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0) {
      pendingIds = new Set((m as any).tool_calls.map((tc: any) => tc?.id).filter(Boolean))
      // 深度思考兼容：assistant 带 tool_calls 的消息必须有 reasoning_content 字段，
      // 否则 DeepSeek 深度思考模式报 "reasoning_content must be passed back"（2026-08-28 补）
      if (!('reasoning_content' in (m as any))) {
        const copy: any = { ...m, reasoning_content: (m as any).reasoning_content || '' }
        out.push(copy)
      } else {
        out.push(m)
      }
      continue
    }
    if (m.role === 'tool' && m.tool_call_id) {
      pendingIds.delete(m.tool_call_id)
      out.push(m)
      continue
    }
    out.push(m)
  }

  // 若还有未配对的 tool_calls（孤立：assistant 声明了工具但后续 tool 消息缺失——
  // 源于压缩切分 / 检查点续跑 / 工具超时中断）。不剔除以保留上下文，改为补占位 tool 消息
  // 满足"每个 tool_call_id 必须有对应 tool 消息"的协议要求（2026-08-28 强化：从"剔除"改为"补全"）。
  if (pendingIds.size > 0) {
    const fixed: AgentMessage[] = []
    for (let i = 0; i < out.length; i++) {
      const m = out[i]
      fixed.push(m)
      // 找到 leading assistant.tool_calls 消息，随后立即补缺失的占位 tool 响应（同一轮内）
      if (m.role === 'assistant' && Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0) {
        const missing = (m as any).tool_calls.filter((tc: any) => pendingIds.has(tc?.id))
        for (const tc of missing) {
          fixed.push({
            role: 'tool' as const,
            tool_call_id: tc.id,
            content: '（该工具调用因中断/压缩未获得实际结果，请基于已有信息继续）',
          })
        }
        // 这些已补全，从 pending 移除（避免下一处 assistant 处重复补）
        for (const tc of missing) pendingIds.delete(tc.id)
      }
    }
    return fixed
  }
  return out
}

/** 读取 settings 配置（工具授权模式等） */
// 思考档位 → 模型参数映射（UI 五档：极简/轻/平衡/深/极深）
function mapReasoningLevel(level?: string): string {
  switch ((level || 'balanced').toLowerCase()) {
    case 'briefest': case 'light': return 'low'
    case 'deep': case 'very-deep': return 'high'
    case 'off': return 'none'
    default: return 'medium'
  }
}

function readSetting(key: string): string {
  try {
    const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row?.value ? String(row.value).trim() : ''
  } catch {
    return ''
  }
}

// ===== Plan 进度管理（横栏任务胶囊：create_plan 落库 tasks 表 → 每轮推进 → done 收尾） =====
interface PlanSnapshot {
  planId: string
  title: string
  steps: Array<{ id: string; subject: string; status: string }>
}

/** 取会话当前活跃计划的步骤快照 */
function getPlanSnapshot(sessionId: string): PlanSnapshot | null {
  try {
    const db = getDB()
    const plan = db.prepare("SELECT * FROM tasks WHERE session_id=? AND parent_id IS NULL AND status='in_progress' ORDER BY created_at DESC LIMIT 1").get(sessionId) as any
    if (!plan) return null
    const steps = db.prepare('SELECT * FROM tasks WHERE parent_id=? ORDER BY sort_order').all(plan.id) as any[]
    if (!steps.length) return null
    return { planId: plan.id, title: plan.subject, steps: steps.map((s: any) => ({ id: s.id, subject: s.subject, status: s.status })) }
  } catch {
    return null
  }
}

/** 推进一步：当前 in_progress → completed，下一个 pending → in_progress */
function advancePlan(sessionId: string): PlanSnapshot | null {
  const db = getDB()
  const plan = db.prepare("SELECT * FROM tasks WHERE session_id=? AND parent_id IS NULL AND status='in_progress' ORDER BY created_at DESC LIMIT 1").get(sessionId) as any
  if (!plan) return null
  const steps = db.prepare('SELECT * FROM tasks WHERE parent_id=? ORDER BY sort_order').all(plan.id) as any[]
  if (!steps.length) return null
  const current = steps.find((s: any) => s.status === 'in_progress')
  if (current) db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(current.id)
  const next = steps.find((s: any) => s.status === 'pending')
  if (next) db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(next.id)
  // 全部完成 → 根任务也标记完成
  const fresh = db.prepare('SELECT * FROM tasks WHERE parent_id=? ORDER BY sort_order').all(plan.id) as any[]
  if (fresh.length > 0 && fresh.every((s: any) => s.status === 'completed')) {
    db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(plan.id)
  }
  return { planId: plan.id, title: plan.subject, steps: fresh.map((s: any) => ({ id: s.id, subject: s.subject, status: s.status })) }
}

/** 任务结束：全部步骤 + 根任务标记完成 */
function finishPlan(sessionId: string): PlanSnapshot | null {
  const db = getDB()
  const plan = db.prepare("SELECT * FROM tasks WHERE session_id=? AND parent_id IS NULL AND status='in_progress' ORDER BY created_at DESC LIMIT 1").get(sessionId) as any
  if (!plan) return null
  db.prepare("UPDATE tasks SET status='completed' WHERE parent_id=?").run(plan.id)
  db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(plan.id)
  const steps = db.prepare('SELECT * FROM tasks WHERE parent_id=? ORDER BY sort_order').all(plan.id) as any[]
  return { planId: plan.id, title: plan.subject, steps: steps.map((s: any) => ({ id: s.id, subject: s.subject, status: 'completed' })) }
}

import { classifyApiError, jitteredBackoff } from './error-classifier'
import { ToolGuardrailController } from './tool-guardrails'
import { shouldCompress, compressContext, pruneOldToolResults } from './context-compressor'
import { matchPlaybooks } from './playbook-match'
import { maybeCreateSkill, maybeRepairSkill } from './skill-evolve'

interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: ToolCall[]
  tool_call_id?: string
  reasoning_content?: string
}

interface AgentConfig {
  model: string
  apiKey: string
  baseUrl?: string
  temperature: number
  maxTokens: number
  systemPrompt: string
  maxTurns: number
}

interface AgentCheckpoint {
  id: string
  turn: number
  messages: AgentMessage[]
  createdFiles: Array<{ name: string; path: string; mime: string; size?: number }>
  totalToolCalls: string[]
  timestamp: string
}

// ---- P0: 动态 maxTurns 配置 ----
const TURN_CONFIG = {
  CHECKPOINT_INTERVAL: 5,       // 每 5 轮存一次检查点
  BASE_MAX_TURNS: 100,          // 默认最大轮次（对齐 WorkBuddy：上限高到实际任务不触达）
  SIMPLE_TASK_TURNS: 50,        // 简单任务（问候/知识问答）
  COMPLEX_TASK_TURNS: 200,      // 复杂任务（全局诊断/代码重构）——放开，靠 ToolCallLoopDetector 防死循环
  PLANNER_OVERHEAD: 4,          // Planner 模式的规划轮次开销
}

/**
 * ---- ToolCallLoopDetector（WorkBuddy 同款）----
 * 检测模型重复调用同一工具且参数几乎相同（连续 ≥ LOOP_THRESHOLD 次 → 命中）。
 * 防死循环：模型卡在"同一条命令反复试"时主动干预，而不是烧 token 到轮次上限。
 */
const TOOL_CALL_HISTORY: Array<{ name: string; hash: number }> = []
const LOOP_THRESHOLD = 4
const LOOP_HISTORY_MAX = 12

/** 简单字符串 hash（参数归一化用，不追求密码学强度） */
function simpleHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

function detectToolLoop(calls: Array<{ function?: { name?: string; arguments?: string } }>): { name: string; count: number } | null {
  for (const tc of calls) {
    const name = tc.function?.name || 'unknown'
    const args = (tc.function?.arguments || '').trim()
    const hash = simpleHash(args)
    TOOL_CALL_HISTORY.push({ name, hash })
    const same = TOOL_CALL_HISTORY.filter((h) => h.name === name && h.hash === hash)
    if (same.length >= LOOP_THRESHOLD) {
      TOOL_CALL_HISTORY.length = 0 // 命中后清空，避免连续误报
      return { name, count: same.length }
    }
  }
  while (TOOL_CALL_HISTORY.length > LOOP_HISTORY_MAX) TOOL_CALL_HISTORY.shift()
  return null
}

/** 估计任务复杂度，返回建议 maxTurns */function estimateComplexity(userMessages: Array<{ role: string; content: string }>): number {
  const lastMsg = [...userMessages].reverse().find(m => m.role === 'user')?.content || ''
  const allText = userMessages.map(m => m.content).join(' ').toLowerCase()

  // 复杂任务关键词
  const complexPatterns = [
    /全局诊断|全面检查|代码审计|全量|全部|所有|整个项目|重构|全面优化/,
    /review.*all|audit.*all|full.*check|entire.*project|refactor.*all/i,
    /分析.*所有|检查.*所有|扫描.*全部/,
    /planner|plan.*mode|计划.*执行/,
  ]

  // 简单任务关键词（仅当消息较短时生效——长任务描述即使含"如何/怎么"也是复杂任务）
  const simplePatterns = [
    /你好|你是谁|hello|hi|hey|什么是|怎么|如何/,
    /what is|who are|tell me|explain/,
  ]

  for (const p of complexPatterns) {
    if (p.test(allText)) return TURN_CONFIG.COMPLEX_TASK_TURNS
  }

  // 简单判定：只对短消息（≤80 字符）生效，避免"如何修复 XXX 的所有问题"这种长任务被误判为简单
  // （content 可能是 blocks 数组（视觉注入），先归一化为字符串）
  const lastMsgText = typeof lastMsg === 'string' ? lastMsg : ''
  if (lastMsgText.trim().length <= 80) {
    for (const p of simplePatterns) {
      if (p.test(lastMsgText)) return TURN_CONFIG.SIMPLE_TASK_TURNS
    }
  }

  // 工具调用密度估计：消息越长、越结构化 → 越复杂
  const msgCount = userMessages.length
  const totalLen = allText.length
  // 长度/多轮 → 较多轮次但不触发 Planner（55 < COMPLEX_TASK_TURNS=60）：
  // 之前这里 min(65,60)=60 正好达到 planner 阈值 → 普通长消息也触发 Planner 的额外 LLM 调用，多等 2~5s
  if (msgCount > 5 || totalLen > 1000) return TURN_CONFIG.COMPLEX_TASK_TURNS - 5

  return TURN_CONFIG.BASE_MAX_TURNS
}

/**
 * 发送 SSE 事件给前端（带自增 seq 写入标准 id 行——断线重连去重/续传的基础，对齐 WorkBuddy eventId 机制）
 */
const sseSeqMap = new WeakMap<object, number>()
function emitSSE(ctx: Context, event: string, data: any) {
  const seq = (sseSeqMap.get(ctx) || 0) + 1
  sseSeqMap.set(ctx, seq)
  ctx.res.write(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// ---- 上下文窗口：按模型动态配置（体验补强 1）----
// 内置常见模型窗口映射（按模型名前缀匹配，命中即用）
const MODEL_CONTEXT_WINDOWS: Array<[RegExp, number]> = [
  [/gemini/i, 1_000_000],
  [/grok/i, 1_000_000],
  [/qwen/i, 1_000_000],
  [/glm-4\.6/i, 200_000],
  [/claude/i, 200_000],
  [/gpt-4\.1/i, 1_000_000],
  [/kimi/i, 128_000],
  [/deepseek/i, 128_000],
  [/moonshot/i, 128_000],
]
const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * 解析模型上下文窗口（tokens）：
 * 1. custom_models 表 context_window 字段（用户可配）优先
 * 2. 内置模型名映射
 * 3. 默认 128K
 */
export function getContextWindowForModel(model: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW
  try {
    const db = getDB()
    const row = db.prepare('SELECT context_window FROM custom_models WHERE model_id = ? LIMIT 1').get(model) as any
    const cw = row?.context_window
    if (cw && Number(cw) > 0) return Number(cw)
  } catch { /* 表可能无此列（迁移前），走内置映射 */ }
  for (const [re, win] of MODEL_CONTEXT_WINDOWS) {
    if (re.test(model)) return win
  }
  return DEFAULT_CONTEXT_WINDOW
}

// 模型单价（¥/1M tokens，近似公开定价；未收录模型用默认值，费用为估算值）
const MODEL_PRICES: Record<string, { prompt: number; completion: number }> = {
  'deepseek-v4-pro': { prompt: 2, completion: 8 },
  'deepseek-v4-flash': { prompt: 1, completion: 4 },
  'deepseek-chat': { prompt: 0.5, completion: 2 },
  'kimi-k2.6': { prompt: 4, completion: 16 },
  'moonshot-v1-8k': { prompt: 4, completion: 16 },
  'gpt-4o': { prompt: 18, completion: 72 },
  'gpt-4.1': { prompt: 15, completion: 60 },
  'claude-sonnet-4-20250514': { prompt: 21, completion: 105 },
  'glm-4.7': { prompt: 2, completion: 6 },
  'mimo-v2.5-pro': { prompt: 2, completion: 8 },
}
const DEFAULT_PRICE = { prompt: 2, completion: 8 }

/** 按模型单价估算本轮费用（¥，保留 3 位小数） */
export function estimateCost(model: string | undefined, usage: { prompt_tokens?: number; completion_tokens?: number }): number {
  const p = MODEL_PRICES[model || ''] || DEFAULT_PRICE
  const promptTokens = usage.prompt_tokens || 0
  const completionTokens = usage.completion_tokens || 0
  return Math.round(((promptTokens * p.prompt + completionTokens * p.completion) / 1e6) * 1000) / 1000
}

/**
 * 从数据库加载相关记忆并构建系统提示
 */
function buildSystemPrompt(basePrompt: string, userMessage: string, model?: string, roleId?: string, sessionWorkspace?: string, uiLanguage?: string): { prompt: string; matchedSkills: Array<{ name: string; name_en: string }>; allowedTools: string[] } {
  const db = getDB()

  // 权威当前日期（北京时间）——注入系统提示，防止模型靠搜索结果/记忆日期反推"今天"（曾把 8/23 当 8/22）
  const now = new Date()
  const todayCN = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
  const todayISO = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) // YYYY-MM-DD
  const todaySection = `\n\n## 当前日期（权威，判断"今天"必须以此为准）\n今天是 ${todayCN}（北京时间）。涉及"今天/今日/最新/现在"的时间判断一律以本日期为准，禁止用搜索结果或记忆中的日期反推今天是几号。仅发布日期等于今天（${todayISO}）的新闻可标注"今日"，其余必须标注真实发布日期（如"8月21日"）。`

  // 触发智能：时间敏感词检测 → 命中则强制要求先搜索，禁止凭训练数据答过时内容
  const TIME_SENSITIVE_RE = /今天|今日|昨天|明天|本周|这周|上月|本月|最近|近日|最新|实时|现在|当前|刚发布|新发布|202[4-9]年|去年|今年/
  const timeSensitive = TIME_SENSITIVE_RE.test(userMessage)
  const searchTriggerSection = timeSensitive
    ? `\n\n## 时效性强制要求（必须遵守）\n检测到用户问题涉及时效性（"最新/今天/本周/2026年"等）。你必须**首先调用 web_search**（时效性问题传 timeRange 参数）获取最新信息后再回答，绝对禁止只凭训练数据回答可能过时的内容。搜索后每条事实性结论必须标注来源 URL 与真实发布日期，来源必须真实存在，禁止编造。`
    : ''

  // 2026-08-25 13:5x：输出风格约束——模型常在正文里写"我先搜索/搜到几条候选/我排除了旧闻"这类过程叙述，
  // 用户看到"正式结果出来了上面还平铺着一堆过程"。过程通过工具调用自然发生，正文只给最终结果。
  // 17:2x 追加：来源格式规范——引用来源统一 markdown 链接 [媒体名](url) 置于消息末尾（多条空格分隔），
  // 前端自动提取为"来源"卡片；不要在正文段落内内联来源链接串（会挤成一行）。
  const outputStyleSection = `\n\n## 输出风格（必须遵守）\n不要在回复正文中叙述你的执行过程（如"我先搜索了…"、"搜索结果显示…"、"我排除了旧闻…"、"让我核实一下…"、"找到了候选新闻…"）。工具调用过程用户自会看到，正文直接给出最终结果/结论（标题、要点、来源）。若多轮工具后有需要补充的最终结论，直接补充结论本身，不要回顾过程。引用来源统一用 markdown 链接格式 \`[媒体名](url)\` 放在消息末尾（多条来源用空格分隔、不要写在正文段落中间），前端会自动把末尾的来源链接提取成"来源"卡片，正文只留说明文字。`


  // 读取记忆开关
  const memoryEnabledRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryEnabled') as any
  const memoryEnabled = memoryEnabledRow ? memoryEnabledRow.value === 'true' : true

  const memoryCharLimitRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryCharLimit') as any
  const memoryLimit = memoryCharLimitRow ? parseInt(memoryCharLimitRow.value) || 50000 : 50000
  const memoryItemLimit = Math.max(5, Math.floor(memoryLimit / 2000))  // 按字符预算估算条数

  // 角色级记忆隔离：有 roleId 时只注入该角色的记忆（+全局记忆），无则全部
  // P0.1：先按 importance 取候选（预算 3 倍），再走 rankMemories 综合排序（importance×confidence×时间衰减×分类权重）
  const memories = memoryEnabled ? (() => {
    const candidates = db.prepare(
      `SELECT id, key, content, category, importance, confidence, usage_count, last_used FROM agent_memory
       WHERE role_id IS NULL OR role_id = ? OR role_id = ''
       ORDER BY importance DESC LIMIT ${memoryItemLimit * 3}`
    ).all(roleId || '') as any[]
    return rankMemories(candidates).slice(0, memoryItemLimit)
  })() : []

  let memorySection = ''
  if (memories.length > 0) {
    memorySection = '\n\n## Stored Memories\n' +
      memories.map((m: any) => `- [${m.key}] (${m.category}, importance:${m.importance}) ${m.content}`).join('\n') +
      '\n\nUse these memories to personalize your responses. Use the memory_store tool to save important new information.'
  }

  // P0.1：Related Memories 从 LIKE 前 50 字符 → FTS5 语义检索 + ranking（措辞不同也能召回相关记忆）
  const relatedMemories = memoryEnabled ? memoryRankedSearch(userMessage, 5, roleId) : []

  let relatedSection = ''
  if (relatedMemories.length > 0 && memories.length > 5) {
    relatedSection = '\n\n## Related Memories\n' +
      relatedMemories.map((m: any) => `- [${m.key}] ${m.content}`).join('\n')
  }

  const toolsSection = `\n\n## Available Tools\nYou can use the following tools. Call them automatically when needed.\n- memory_store: Store important user info to long-term memory\n- memory_recall: Search stored memories\n- memory_list: List all memories\n- web_search: Search the internet for up-to-date information. **After searching, every factual claim in your answer MUST cite its source URL (e.g. [来源](url)); NEVER fabricate URLs or sources. When the user asks for "today's latest / 最新 / 今天" news: pass timeRange='day' (今天的消息必须用 day，近一周用 week) AND source='news' — news mode returns results with exact publication dates, so filter by date directly and report each item's REAL publication date; NEVER open pages one by one to verify dates (that wastes minutes); items with missing dates are labeled "日期未知". Only items published today may be labeled "今日", others get their actual date (e.g. "8月21日"). Prioritize authoritative sources when citing: ① official channels (company/product official sites, official blogs, official GitHub) ② established media (TechCrunch, Reuters, Bloomberg, The Information, 新浪财经, etc.) ③ academic sources (arxiv, ACL, university labs) for technical topics; de-prioritize AI-tool aggregator sites and trending-list sites (AI工具集/AI热榜 style) which are often stale or clickbait.**\n- news_search: Search SUPERCRZY's own AI news library (supercrzy.com, real-time, each item has precise publication date + category Models/Business/Hardware/Agents/Open Source/Research). **When the user asks about 最近/今日/最新 AI 动态、模型/硬件/Agent 进展、或具体方向(如 '推理成本' '某模型') — prefer news_search first (time-accurate by built-in dates), then web_search for cross-source depth. After returning, if an item deserves deeper digging, call deep_research on it.**\n- web_fetch: Fetch web page content (JS-rendered pages supported). Prefer it to read full pages instead of guessing.
- deep_research: Deep research engine — multi-round recursive search + AI distillation producing a 3+ page report with sources. **When the user asks for 深度研究 / 全面调研 / 深入调查 / 写研究报告 / 完整分析报告 (deep research, comprehensive investigation, research report), you MUST call deep_research (NOT just web_search)**, with a clear query and optional breadth/depth.\n- file_read/file_write/file_exists: Read/write/check local files. **Write/create files MUST use file_write (never use shell_exec with echo/cat/heredoc to write files)**\n- draw_diagram: Draw vector diagrams (architecture/flow/comparison) as SVG, shown instantly in the conversation. **When the user asks you to draw a diagram, chart, architecture, flowchart or illustration — you MUST call this tool and output the SVG code, never replace it with plain-text tables.**\n- shell_exec: Execute shell commands (read-only/query only — view, search, test, build; **never write files via shell**). **ALWAYS include a "description" argument** — one short sentence explaining what the command does (e.g. "check where deeplink.ts is defined"); it is shown as the command card title.\n- ask_question: Ask the user a structured question when you need a decision or missing info\n- create_plan: For complex tasks (more than 2 steps), create a step-by-step plan first\n- git_status/git_diff/git_commit: Inspect and commit code changes when working in a git repo
- computer_use: Control the user's computer (screenshot/click/type/keys) — only in full permission mode, always confirmed by user\n- skill_list: List all installed skills\n- skill_search: Search for third-party skills on GitHub\n- skill_view: View skill details and prompt template\n- skill_install: Install a skill from a GitHub repository`

  let skillIndexSection = ''
  let skillSection = ''
  let matchedSkills: Array<{ name: string; name_en: string }> = []
  let skillTools: string[] = []

  let allSkills: any[] = []
  try {
    allSkills = db.prepare(
      `SELECT name, description, prompt_template, tools, trigger_keywords, globs, environments, scoped_to FROM skills WHERE enabled = 1`
    ).all() as any[]

    // 工作区文件树（供 globs 匹配）：只取顶层文件名，避免大目录扫描
    let workspaceFileNames: string[] = []
    if (sessionWorkspace) {
      try {
        workspaceFileNames = readdirSync(sessionWorkspace).map((f: string) => f)
      } catch { /* 目录不可读则跳过 globs 匹配 */ }
    }

    if (allSkills.length > 0) {
      skillIndexSection = '\n\n## Installed Skills\n' +
        allSkills.map((s: any) => `- [${s.name}] ${s.description}`).join('\n') +
        '\n\nUse skill_list() for details, skill_search() to find new skills, skill_install() to install.'
    }

    const relevantSkills = allSkills.filter((s: any) => {
      const q = userMessage.toLowerCase()
      // 0) environments 过滤：不匹配当前环境的技能直接排除
      if (s.environments) {
        const envs = String(s.environments).split(',').map((e: string) => e.trim().toLowerCase())
        if (envs.length > 0 && !envs.includes('all')) {
          const currentEnv = model?.includes('vision') ? 'vision' : 'node'
          if (!envs.includes(currentEnv) && !envs.some((e: string) => q.includes(e))) return false
        }
      }
      // 1) 关键词触发（trigger_keywords，含安装时自动生成的开源技能关键词）
      if (s.trigger_keywords) {
        const keywords = s.trigger_keywords.split(',').map((k: string) => k.trim().toLowerCase()).filter(Boolean)
        if (keywords.some((kw: string) => q.includes(kw) || kw.includes(q))) return true
      }
      // 1.5) globs 文件匹配：技能声明了文件模式，且当前工作区有对应文件 → 激活
      if (s.globs && workspaceFileNames.length > 0) {
        try {
          const patterns = JSON.parse(s.globs) as string[]
          if (patterns.some((p: string) => workspaceFileNames.some((f: string) => f.toLowerCase().endsWith(p.replace('**/', '').replace(/^\*\./, '.').toLowerCase())))) return true
        } catch { /* globs 解析失败则忽略 */ }
      }
      // 2) description 语义兜底：用户查询的关键词出现在技能描述中 → 激活
      if (s.description) {
        const desc = s.description.toLowerCase()
        const terms = q.replace(/[，。！？；、,.!?;:]/g, ' ').split(/\s+/).filter((w) => w.length >= 2)
        if (terms.some((t: string) => desc.includes(t))) return true
      }
      return false
    })

    if (relevantSkills.length > 0) {
      matchedSkills = relevantSkills.map((s: any) => ({ name: s.name, name_en: s.name_en || '' }))
      skillSection = '\n\n## Activated Skills\n' +
        relevantSkills.map((s: any) =>
          `- [${s.name}] ${s.description}\n  ${s.prompt_template ? 'Prompt: ' + s.prompt_template : ''}`
        ).join('\n') +
        '\n\nCombine the expertise and prompt templates of the above skills to optimize your response.'

      for (const s of relevantSkills) {
        if (s.tools) {
          try {
            const tools = typeof s.tools === 'string' ? JSON.parse(s.tools) : s.tools
            if (Array.isArray(tools)) skillTools.push(...tools)
          } catch {}
        }
      }
    }
  } catch {}

  // 基础白名单 = 全部 28 个内置工具（2026-08-24 修复：原 18 个缺 file_read/file_write/multi_edit/shell_exec 等核心文件工具，
  // 用户一旦自定义 allowedTools 就会过滤丢核心能力 → 补齐为全量，自定义仅作"追加技能工具"而非缩减）
  const baseTools = [
    'memory_store', 'memory_recall', 'memory_list',
    'file_read', 'file_write', 'file_exists', 'multi_edit', 'lint_file', 'read_me',
    'shell_exec', 'web_search', 'web_fetch', 'deep_research', 'news_search',
    'draw_diagram', 'generate_image', 'video_edit', 'ask_question', 'ask_user',
    'task_create', 'task_update', 'task_list', 'create_plan', 'get_goal',
    'git_status', 'git_diff', 'git_commit',
    'computer_use',
    'terminal_open', 'terminal_list', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close',
    'skill_list', 'skill_search', 'skill_view', 'skill_install',
  ]
  const allowedTools = [...new Set([...baseTools, ...skillTools])]

  const prompt = `${basePrompt}${todaySection}${searchTriggerSection}${outputStyleSection}

## Response Language (MUST FOLLOW)
- Always reply in the SAME LANGUAGE the user writes in. If the user writes English, reply in English. If Chinese, reply in Chinese.
- User's UI language: ${uiLanguage || 'unknown'} (UI language is a hint, not a rule — the user's message language wins).
- Never switch to Chinese just because system sections below are written in Chinese; those are instructions for you, not for the user.

## 引用标记（用户可能引用对话内容，必须优先回应）
用户消息中如果出现「> 用户引用：xxx」或「> AI 回复引用：xxx」标记（引用块），表示用户引用了某条历史消息的原文来引导你——**引用的内容是最重要的上下文，必须先针对引用内容回应**（确认/纠正/说明），再处理其后的新提问；不要把引用内容当作普通正文忽略。

## 画图规则（必须遵守）
- 当用户要求**画图 / 画架构图 / 流程图 / 示意图 / 图表 / 对比图**时：必须输出 \`\`\`svg 代码块（或用 draw_diagram 工具），系统会把图实时渲染在对话里。
- **绝对禁止**：只用文字、表格、文字描述代替真正的 SVG 图。用户要的是图，不是文字。
- SVG 规范：viewBox="0 0 680 420"，用 rect/circle/text/path 画图，文字必须有 fill 颜色，配色清晰可读。

## Working Directory
你当前的工作目录是：**${sessionWorkspace || '项目根目录'}**
- 文件读写（file_read / file_write / file_exists）请**优先使用相对路径**（相对于上述工作目录），不要猜测或拼接绝对路径。
- shell_exec 命令默认也在该目录下执行。
- 如需访问工作目录之外的文件，使用绝对路径（沙箱会校验权限）。

## Your Setup
- Model: **${model || 'deepseek-v4-pro'}** | Platform: SUPERCRZY BOT
- 持久记忆系统：${memoryEnabled ? `已启用，当前存有 ${memories.length} 条长期记忆（用户偏好、项目事实、经验教训），可跨对话存储与检索（memory_store/memory_recall）` : '未启用'}
- 技能系统：${allSkills.length} 个已安装技能（文档/搜索/开发/创意/办公等，按需自动触发）
- 工具：文件读写、Shell 执行、网页搜索/抓取、记忆存取、技能管理
- 渠道接入：Web 聊天、Telegram、QQ、微信、钉钉、飞书、Slack、Discord、企业微信（多渠道收发消息）
- 交付能力：可真实执行任务并产出文件/数据/HTML 等可验证结果

## Core Principle
The deliverable is a working result backed by real tool output — not a description of one.
Do not stop at a plan or a stub. Keep going until the task is done and you can show real output.
If something blocks you, say so directly. Never fabricate results.

## Rules
1. Simple questions → answer directly. No tools needed.
2. Tasks → do them end to end. Run it, verify it works, show the output.
3. Something fails → try a different way immediately.
4. Stuck after 2 tries → tell the user what's blocking you.
5. Be concise. Show results, not process.
6. Alternate between brief reply notes and tool calls: before/after each tool call, write 1-2 short sentences in the reply explaining what you're doing (e.g. "Let me check the project structure first", "Found N issues, fixing the first one", "Tests passed, moving on"). This keeps the user informed like ChatGPT/WorkBuddy. Only skip the note for trivial steps.
7. Never stop early: keep calling tools until the task is truly complete (all sub-steps done and verified). Do not output a final answer or stop calling tools while work remains — e.g. if you found issues, fix and verify them all; if you only inspected, finish the actual work. A short "final report" before finishing the job is a failure.

## 目标保持（goal，必须遵守）
- 复杂/长任务开始前：先用 **create_plan** 创建结构化计划（标题 + 步骤），并在执行中同步 task_update 更新步骤状态（in_progress/completed）。
- 执行中途（完成关键步骤后、或感觉方向可能偏离时）：调用 **get_goal** 自查原始目标与当前进度，确认没有偏离用户需求主线。
- 一旦发现偏离：立即回到目标主线，或向用户说明当前发现的新情况并征询调整。禁止做着做着忘记原始需求。

## 输出纪律（必须遵守）
- **思考（reasoning/thinking）只用于内部推理**：分析、规划、拆解步骤。绝对禁止在思考中输出最终报告、结论、结果表格或总结性长文——思考是过程，不是交付物。
- **思考中禁止输出任何结构化内容**：表格（| 分隔的行）、编号列表、步骤明细、"第 N 步…✅"式进度汇报、结果汇总——这些全部属于正文。思考只允许 1-2 句简短的过程性提示（如"检查环境后开始"），一旦出现结构化内容必须转移到正文。
- **思考内容用户完全看不到**：最终报告如果写在思考里，等于没有输出。所有结论、表格、总结必须出现在正文（回复内容）里。
- **每轮工具调用前后，在正文输出 1-2 句简短说明**（如"先检查项目结构"、"发现问题，开始修复"、"测试通过，继续下一步"），让用户像看 ChatGPT/WorkBuddy 一样实时看到进度。**最终完整报告/结论在所有工具执行完成后**，以正文输出。顺序必须是：简短说明 → 工具调用 → 简短说明 → 工具调用 → … → 最终完整报告。
- **报告必须与真实工具结果一致**：只陈述实际执行过的操作和真实返回的数据。不得声称未执行的操作、不得夸大执行细节（例如报告说"用生产链路 /api/ocr"但实际直接跑脚本）、不得编造工具输出。
- **工具失败要如实说明**：如果某个工具/命令失败或跳过，在正文里向用户说明原因，不要静默跳过当作没发生。
- 任务完成时，最后一轮正文必须给出明确的最终结论（不要只输出内部推理就结束）。

## Memory
你是带长期记忆的助手。使用规则：
- **何时存（memory_store）**：用户在对话中透出可复用的个人事实时保存——①偏好（"以后都用简洁回答"）②项目事实（"这项目用 pnpm + Koa"）③跨对话相关的关键结论。保存时给一个稳的 key（如 pref:short-answers）和一句话内容。
- **何时召回（memory_recall）**：新对话/新任务**开始前**，先召回与本次任务相关的记忆（用户是谁、历史偏好、做过什么类似任务），避免答非所问或重复提问。
- **何时不存**：临时性、一次性、与任务无关的内容不存，避免记忆库膨胀。下结论前若记忆里已有该用户偏好，直接遵循，不必再问。
Save important facts with memory_store. Retrieve relevant history with memory_recall before starting a task.

${memorySection}${relatedSection}${toolsSection}${skillIndexSection}${skillSection}`

  return { prompt, matchedSkills, allowedTools }
}

/**
 * P0: 保存检查点到文件系统
 */
async function saveCheckpoint(checkpoint: AgentCheckpoint): Promise<string> {
  const dir = join(config.workspaceDir, 'data', 'checkpoints')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${checkpoint.id}.json`)
  await writeFile(path, JSON.stringify(checkpoint, null, 2), 'utf-8')
  return path
}

/**
 * 任务收尾自动写日志（2026-08-26 老板："AI 没写日记 MD 的习惯"）。
 * 每次任务完成把关键信息追加到工作区 logs/YYYY-MM-DD.md（UTF-8，追加，自动建目录/文件）。
 * 内容：时间 / 用户请求 / AI 摘要(截断) / 工具调用 / 轮数 / 模型。异步非阻塞，失败静默。
 */
/** 任务日志目录：2026-08-26 老板选"用户数据目录"→ ~/.supercrzy/logs（开源后不进仓库，git 零污染）。
 *  WorkBuddy 同思路（日志放 OS 数据目录，不放源码仓库）。 */
function getTaskLogDir(): string {
  return join(os.homedir(), '.supercrzy', 'logs')
}

async function appendTaskLog(opts: {
  userContent: string
  summary: string
  toolCount: number
  turns: number
  model: string
}) {
  try {
    const { userContent, summary, toolCount, turns, model } = opts
    const dir = getTaskLogDir()
    await mkdir(dir, { recursive: true })
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const file = join(dir, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.md`)
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    const uq = userContent.slice(0, 200)
    const sum = (summary || '').replace(/\n+/g, ' ').slice(0, 500)
    const block =
      `\n## ${time} · ${model}\n` +
      `- **请求**：${uq}\n` +
      `- **摘要**：${sum}\n` +
      `- **统计**：${toolCount} 次工具调用 · ${turns} 轮\n\n`
    await appendFile(file, block, 'utf-8')
  } catch (e: any) {
    console.log(`[TaskLog] 追加失败: ${e?.message || e}`)
  }
}

/**
 * 读取最近的任务日志摘要（2026-08-26：续跑时注入上次任务日志作上下文，让 Agent 有"上次干到哪"依据）。
 * 返回 logs/ 目录里最近修改的 .md 文件的末尾摘要（最多 800 字）。失败返回空串。
 */
async function readLatestTaskLog(): Promise<string> {
  try {
    const { readdir, stat, readFile } = await import('fs/promises')
    const dir = getTaskLogDir()
    let names: string[] = []
    try { names = await readdir(dir) } catch { return '' }
    const mds = names.filter((n) => n.endsWith('.md'))
    if (mds.length === 0) return ''
    // 按修改时间取最新文件
    let newest = mds[0], newestTime = 0
    for (const n of mds) {
      try { const s = await stat(join(dir, n)); if (s.mtimeMs > newestTime) { newestTime = s.mtimeMs; newest = n } } catch {}
    }
    const content = await readFile(join(dir, newest), 'utf-8')
    // 取末尾最近几条 ## 任务条目（最多 800 字）
    return content.slice(-800).trim()
  } catch (e: any) {
    console.log(`[TaskLog] 读取日志失败: ${e?.message || e}`)
    return ''
  }
}
/**
 * 核心 Agent Loop
 * P0: 动态 maxTurns + 检查点 + 续跑
 */

export async function runAgentLoop(
  ctx: Context,
  userMessages: Array<{ role: string; content: string }>,
  agentConfig: AgentConfig,
  resumeCheckpoint?: string,  // P0: 从检查点续跑
  sessionId?: string,  // 会话级工具授权标识
  sessionCfg?: { workspaceDir?: string; permissionLevel?: 'workspace-only' | 'sandbox' | 'full' },  // 会话级工作目录 + 默认权限
  uiLanguage?: string,  // 前端界面语言（zh-CN / en-US），用于 AI 回复语言跟随
) {
  const sessionWorkspace = sessionCfg?.workspaceDir || ''
  const permissionLevel = sessionCfg?.permissionLevel || 'sandbox'
  // ---- 动态 maxTurns ----
  // 用户配置的 maxTurns 就是上限，简单任务靠 estimateComplexity 自动缩短
  // （修复：之前 estimateComplexity 从未被调用 → 所有消息都按用户上限走 → "hello"也触发 planner）
  const effectiveMaxTurns = resumeCheckpoint
    ? agentConfig.maxTurns
    : Math.min(agentConfig.maxTurns || 300, estimateComplexity(userMessages))

  const checkpointId = randomUUID()
  // P2-1 模型 fallback 标记（主模型失败切备用，只切一次避免循环）
  let modelFallbackUsed = false

  // ---- 上下文窗口：按模型动态配置（体验补强 1）----
  const contextWindow = getContextWindowForModel(agentConfig.model)

  emitSSE(ctx, 'config', {
    maxTurns: effectiveMaxTurns,
    checkpointId,
    resumed: !!resumeCheckpoint,
    contextWindow,
    model: agentConfig.model,
  })

  // ---- 消息初始化（支持续跑） ----
  let messages: AgentMessage[]
  let resumedTurn = 0  // 检查点恢复时的轮次

  if (resumeCheckpoint) {
    // 从检查点恢复
    try {
      const { readFile } = await import('fs/promises')
      const ckptData = await readFile(resumeCheckpoint, 'utf-8')
      const ckpt: AgentCheckpoint = JSON.parse(ckptData)
      messages = ckpt.messages
      resumedTurn = ckpt.turn || 0
      // 读取最近任务日志摘要，注入续跑上下文（2026-08-26：让 Agent 知道上次干到哪、避免重复）。
      const taskLogSummary = await readLatestTaskLog()
      let resumeNotice = `[系统提示] 你正在从检查点恢复执行（第 ${ckpt.turn} 轮）。请继续完成之前未完成的任务，不要重复已完成的工作。`
      if (taskLogSummary) {
        resumeNotice += `\n\n## 上次任务日志（最近记录，作参考了解进度，勿重复已完成工作）\n${taskLogSummary}`
      }
      messages.push({ role: 'user', content: resumeNotice })
      emitSSE(ctx, 'checkpoint_resumed', {
        fromTurn: ckpt.turn,
        savedFiles: ckpt.createdFiles.length,
        toolCalls: ckpt.totalToolCalls.length,
      })
    } catch (err: any) {
      emitSSE(ctx, 'error', { message: `Failed to resume checkpoint: ${err.message}` })
      messages = userMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    }
  } else {
    messages = userMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  }

  const lastUserMsg = [...userMessages].reverse().find(m => m.role === 'user')
  const lastUserContent = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : ''

  // ---- 角色分发：按消息匹配专家角色，命中则用角色系统提示 ----
  let activeRole: { id: string; name: string } | null = null
  try {
    const { matchRole, getDefaultRole } = await import('./role-router')
    const matched = matchRole(lastUserContent)
    const role = matched.role || getDefaultRole()
    if (role) {
      activeRole = { id: role.id, name: role.name }
      // 命中专家角色（非默认）或显式有角色的系统提示时，覆盖 basePrompt
      if (role.system_prompt) {
        agentConfig.systemPrompt = role.system_prompt
      }
      // 角色显示名：英文界面用 name_en，中文界面用 name（兜底原值）
      const roleDisplayName = uiLanguage?.startsWith('zh')
        ? role.name
        : (role.name_en || role.name)
      emitSSE(ctx, 'role_routed', { roleId: role.id, roleName: roleDisplayName, matchedKeyword: matched.matchedKeyword || '' })
      console.log(`[Role] 任务分发 → ${role.name} (keyword: ${matched.matchedKeyword || 'default'})`)
    }
  } catch (err: any) {
    console.warn(`[Role] 角色分发失败（回退默认）: ${err.message}`)
  }

  const systemPrompt = buildSystemPrompt(agentConfig.systemPrompt, lastUserContent, agentConfig.model, activeRole?.id, sessionWorkspace, uiLanguage)

  // ---- Playbook 经验注入：匹配同类历史任务，避免重复弯路 ----
  try {
    const db = getDB()
    const playbooks = db.prepare(
      'SELECT task_type, lesson FROM playbook ORDER BY created_at DESC LIMIT 30'
    ).all() as Array<{ task_type: string; lesson: string }>
    const relevant = matchPlaybooks(playbooks, lastUserContent)

    if (relevant.length > 0) {
      systemPrompt.prompt +=
        '\n\n## 历史经验（同类任务）\n' +
        relevant.map((p) => `- [${p.task_type}] ${p.lesson}`).join('\n') +
        '\n\n参考上述经验，直接采用已验证的高效路径，避免重复弯路。'
      for (const p of relevant) {
        emitSSE(ctx, 'playbook_used', { taskType: p.task_type, lesson: p.lesson })
      }
    }
  } catch { /* 经验注入失败不影响主流程 */ }

  for (const skill of systemPrompt.matchedSkills) {
    emitSSE(ctx, 'skill_matched', { name: skill.name, name_en: skill.name_en })
    // P2 Skill Generation：技能命中计数（180 天未用自动停用依据）
    try {
      getDB().prepare("UPDATE skills SET usage_count = usage_count + 1, last_used = datetime('now') WHERE name = ?").run(skill.name)
    } catch { /* 计数失败不影响主流程 */ }
  }

  let activeToolDefs = systemPrompt.allowedTools.length > 3
    ? toolDefinitions.filter(t => systemPrompt.allowedTools.includes(t.name))
    : toolDefinitions

  // ---- MCP 连接器工具注入（用户自定义 MCP server 的工具动态合并） ----
  try {
    const { getAllMcpTools } = await import('./mcp-manager')
    const mcpTools = await getAllMcpTools()
    if (mcpTools.length > 0) {
      const mcpDefs = mcpTools.map(({ serverId, serverName, tool }) => ({
        name: `mcp_${serverId.slice(0, 8)}_${tool.name}`,
        description: `[MCP ${serverName}] ${tool.description || tool.name}`,
        category: 'system' as const,
        parameters: (tool.inputSchema && (tool.inputSchema as any).properties)
          ? { type: 'object', properties: (tool.inputSchema as any).properties, required: (tool.inputSchema as any).required || [] }
          : { type: 'object', properties: {} },
      }))
      activeToolDefs = [...activeToolDefs, ...mcpDefs]
      emitSSE(ctx, 'mcp_tools', { count: mcpDefs.length, servers: [...new Set(mcpTools.map((m) => m.serverName))] })
    }
  } catch { /* MCP 注入失败不影响主流程 */ }

  let turn = resumedTurn  // 从检查点恢复轮次
  let finished = false
  let interrupted: string | null = null  // 2026-08-26：API 中断原因（费用耗尽/不可重试），非空时可续跑
  const db = getDB()  // 顶层 DB 句柄（产物持久化等用）
  const createdFiles: Array<{ name: string; path: string; mime: string; size?: number }> = []
  const totalToolCalls: string[] = []
  let lastCheckpointTurn = 0
  let toolErrorCount = 0  // 工具失败计数器，避免无限重试提示
  let consecutiveApiErrors = 0  // API 连续错误计数器
  let compressionAttempts = 0  // 压缩尝试次数
  let emptyContentCount = 0  // 空内容重试计数
  const guardrail = new ToolGuardrailController()  // 工具循环防护
  let roundStartMs = Date.now()
  const roundDurationsMs: number[] = []

  // ---- P0: Planner Mode ----
  // 在首轮之前，先让 LLM 规划复杂任务
  let plannerSteps: string[] = []

  if (effectiveMaxTurns >= TURN_CONFIG.COMPLEX_TASK_TURNS) {
    emitSSE(ctx, 'planner_start', { message: '🔍 检测到复杂任务，启用 Planner 模式...' })

    // 先做一次无工具的规划调用，让 LLM 列出执行步骤
    const planMessages = [
      { role: 'system', content: `${systemPrompt.prompt}

你现在处于 Planner 模式。请分析用户任务，输出一个分步执行计划（用简洁的 checklist 格式）。不要调用工具，只做分析。` },
      ...messages,
      { role: 'system', content: '请列出执行计划（每行一个步骤，带编号）：' },
    ]

    try {
      const planText = await chatCompletion({
        baseUrl: agentConfig.baseUrl || config.deepseek.baseUrl,
        apiKey: agentConfig.apiKey,
        model: agentConfig.model,
        messages: planMessages,
        temperature: 0.3,
        maxTokens: 800,
      })
      if (planText) {
        // 解析出步骤
        const stepLines = planText.split('\n').filter((l: string) => /^\d+[\.\)\-]/.test(l.trim()) || l.trim().startsWith('- ['))
        if (stepLines.length > 0) {
          plannerSteps = stepLines
          emitSSE(ctx, 'planner_plan', { steps: plannerSteps, raw: planText.slice(0, 500) })
        } else {
          emitSSE(ctx, 'planner_plan', { steps: [planText.slice(0, 300)], raw: planText.slice(0, 300) })
        }
      }
    } catch (planErr: any) {
      emitSSE(ctx, 'planner_plan', { steps: ['(规划调用失败，直接执行)'], error: planErr.message })
    }
  }

  while (turn < effectiveMaxTurns && !finished) {
    turn++
    const roundDuration = turn > 1 ? Date.now() - roundStartMs : 0
    if (roundDuration > 0) roundDurationsMs.push(roundDuration)
    roundStartMs = Date.now()
    const avgRoundMs = roundDurationsMs.length > 0
      ? Math.round(roundDurationsMs.reduce((a, b) => a + b, 0) / roundDurationsMs.length)
      : 0
    const remaining = effectiveMaxTurns - turn
    const etaMs = avgRoundMs > 0 ? avgRoundMs * remaining : 0
    emitSSE(ctx, 'thinking', {
      turn,
      maxTurns: effectiveMaxTurns,
      remaining,
      avgRoundMs,
      etaMs,
      message: `思考中...`,
    })

    // ---- 上下文压缩：主动裁剪旧工具结果 + 旧 reasoning + 按需 LLM 摘要 ----
    if (turn > 3 && turn % 3 === 0) {
      // 轻量裁剪：每 3 轮裁剪一次旧工具结果
      messages = pruneOldToolResults(messages, 5)
      // 裁剪旧消息的 reasoning_content（保留最近 3 条）
      let reasoningCount = 0
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].reasoning_content) {
          reasoningCount++
          if (reasoningCount > 3) {
            const oldLen = (messages[i].reasoning_content as string).length
            messages[i].reasoning_content = `[reasoning 已裁剪，原长 ${oldLen} 字符]`
          }
        }
      }
    }
    if (turn > 5 && shouldCompress(messages, contextWindow) && compressionAttempts < 3) {
      compressionAttempts++
      emitSSE(ctx, 'compressing', { attempt: compressionAttempts, message: '上下文过长，正在压缩...' })
      const baseUrl = agentConfig.baseUrl || config.deepseek.baseUrl
      const result = await compressContext(messages, agentConfig.apiKey, baseUrl)
      if (result.compressed) {
        messages = result.messages as AgentMessage[]
        emitSSE(ctx, 'compressed', { savedTokens: result.savedTokens })
      }
    }

    // 工具消息序列清洗（2026-08-28 修复 400：检查点/压缩/中断可能留下孤立 tool_calls，发请求前兜底）
    const sanitizedMessages = sanitizeToolCallSequence(messages)
    if (sanitizedMessages.length !== messages.length) {
      console.warn(`[Sanitize] turn ${turn}: 清洗 ${messages.length}→${sanitizedMessages.length} 条消息（移除孤立 tool_calls）`)
    }
    const apiMessages = [
      { role: 'system', content: systemPrompt.prompt },
      ...sanitizedMessages,
    ]

    // P0: 在接近上限时提示模型压缩输出
    if (turn > effectiveMaxTurns - 5 && turn < effectiveMaxTurns) {
      apiMessages.push({
        role: 'system',
        content: `⚠️ 只剩 ${effectiveMaxTurns - turn} 轮思考机会。请尽快给出结论，避免调用非必要工具。完成后不要继续调工具。`,
      })
    }

    try {
      let requestBody = JSON.stringify({
        model: agentConfig.model,
        messages: apiMessages,
        temperature: agentConfig.temperature,
        max_tokens: agentConfig.maxTokens,
        stream: true,
        tools: activeToolDefs.map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: 'auto',
        // 深度思考档位（设置 reasoningLevel，WorkBuddy thinkingLevelMap 同款映射）
        reasoning_effort: mapReasoningLevel(readSetting('reasoningLevel')),
      })
      const baseUrl = agentConfig.baseUrl || config.deepseek.baseUrl
      // 统一走 model-client 网关（keep-alive/认证/错误分类集中，换后端只改 model-client）
      const doFetch = (body: string) => requestChat({
        baseUrl,
        apiKey: agentConfig.apiKey,
        body,
      })

      let response: Response
      // 模型请求已发出、响应未到达（WorkBuddy model_requesting"等待模型响应"同款——消除"暂停几秒"的空白感）
      emitSSE(ctx, 'model_requesting', { turn })
      try {
        response = await doFetch(requestBody)
        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`API error ${response.status}: ${errorText}`)
        }
      } catch (err: any) {
        // P2-1 模型 fallback：主模型失败 → 切备用模型重试一次（WorkBuddy fallbackModel 同款）
        const fb = readSetting('fallbackModel') || 'deepseek-v4-flash'
        if (!fb || fb === agentConfig.model || modelFallbackUsed) throw err
        modelFallbackUsed = true
        console.warn(`[Fallback] 主模型 ${agentConfig.model} 失败（${err.message}），切备用 ${fb} 重试`)
        emitSSE(ctx, 'fallback', { from: agentConfig.model, to: fb, reason: String(err.message).slice(0, 200) })
        requestBody = JSON.stringify({ ...JSON.parse(requestBody), model: fb })
        response = await doFetch(requestBody)
        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Fallback API error ${response.status}: ${errorText}`)
        }
      }

      consecutiveApiErrors = 0  // API 调用成功，重置错误计数

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''
      let contentBuffer = ''
      let reasoningBuffer = ''
      const toolCallBuffer: Map<number, { id: string; name: string; args: string }> = new Map()
      // 本轮真实 token 用量（流式结束时的 usage 字段）
      let lastUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          // Flush decoder buffer and process remaining data
          buffer += decoder.decode()
          const remainingLines = buffer.split("\n")
          for (const line of remainingLines) {
            if (!line.startsWith("data: ")) continue
            const ds = line.slice(6).trim()
            if (ds === "[DONE]") continue
            try {
              const ch = JSON.parse(ds)
              const dl = ch.choices?.[0]?.delta
              if (dl?.content) {
                // 轮内只累积；轮末统一决定推送（中间工具轮文本不进正文，避免碎文）
                contentBuffer += dl.content
              }
              if (dl?.tool_calls) {
                for (const tc of dl.tool_calls) {
                  const ix = tc.index ?? 0
                  if (!toolCallBuffer.has(ix)) {
                    toolCallBuffer.set(ix, { id: tc.id || "", name: "", args: "" })
                  }
                  const en = toolCallBuffer.get(ix)!
                  if (tc.id) en.id = tc.id
                  if (tc.function?.name) en.name += tc.function.name
                  if (tc.function?.arguments) {
                    en.args += tc.function.arguments
                    // 参数增量流（WorkBuddy 工具参数流式解析同款）：边生成边推，前端增量渲染
                    if (en.name) emitSSE(ctx, 'tool_args_chunk', { toolCallId: en.id, name: en.name, chunk: tc.function.arguments })
                  }
                }
              }
            } catch {}
          }
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const dataStr = line.slice(6).trim()
          if (dataStr === '[DONE]') continue

          try {
            const chunk = JSON.parse(dataStr)
            const delta = chunk.choices?.[0]?.delta

            // 真实 token 用量：DeepSeek 流式在结束时返回 usage（prompt_tokens/completion_tokens/total_tokens）
            if (chunk.usage) {
              lastUsage = chunk.usage
            }

            if (delta?.content) {
              // 轮内只累积；轮末判断：工具轮 → process_text（不进正文），最终轮 → 分片流式推正文
              contentBuffer += delta.content
            }

            if (delta?.reasoning_content) {
              reasoningBuffer += delta.reasoning_content
              emitSSE(ctx, 'thinking_chunk', { text: delta.reasoning_content, turn })
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                if (!toolCallBuffer.has(idx)) {
                  toolCallBuffer.set(idx, { id: tc.id || '', name: '', args: '' })
                }
                const entry = toolCallBuffer.get(idx)!
                if (tc.id) entry.id = tc.id
                if (tc.function?.name) entry.name += tc.function.name
                if (tc.function?.arguments) {
                  entry.args += tc.function.arguments
                  // 参数增量流：边生成边推，前端增量渲染
                  if (entry.name) emitSSE(ctx, 'tool_args_chunk', { toolCallId: entry.id, name: entry.name, chunk: tc.function.arguments })
                }
              }
            }
          } catch {}
        }
      }

      // 正文收敛策略（WorkBuddy 同款）：中间工具轮的过程文本（"好，我去抓取...🔍"）不进正文区，
      // 避免一段段碎文 + 工具执行停顿造成"卡顿"观感——工具卡片已表达过程；正文只出最终答案。
      if (toolCallBuffer.size === 0 && contentBuffer.trim()) {
        const isJsonish = contentBuffer.startsWith('{') || contentBuffer.startsWith('[')
        if (isJsonish) {
          emitSSE(ctx, 'content_chunk', { text: contentBuffer })
        } else {
          // 分片模拟流式（每片 8 字符 4ms，1KB 约 500ms），保留"逐字出现"观感
          for (let i = 0; i < contentBuffer.length; i += 8) {
            emitSSE(ctx, 'content_chunk', { text: contentBuffer.slice(i, i + 8) })
            await new Promise((r) => setTimeout(r, 4))
          }
        }
      } else if (toolCallBuffer.size > 0 && contentBuffer.trim()) {
        // 中间工具轮文本：渲染给前端（对齐 WorkBuddy/ChatGPT 交替式——工具间模型会输出简短说明，用户实时看到进度）
        // 修正：之前走 process_text（前端不渲染）导致"只有深度思考和命令、中间无回复"；工具轮正文应平铺显示
        for (let i = 0; i < contentBuffer.length; i += 8) {
          emitSSE(ctx, 'content_chunk', { text: contentBuffer.slice(i, i + 8) })
          await new Promise((r) => setTimeout(r, 4))
        }
      }

      if (toolCallBuffer.size > 0) {
        const toolCalls = Array.from(toolCallBuffer.values()).map(tc => ({
          id: tc.id || randomUUID(),
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.args },
        }))

        const SENSITIVE_TOOLS = new Set(['shell_exec', 'file_write', 'file_delete'])

        // ---- ToolCallLoopDetector（WorkBuddy 同款）：同一工具 + 相似参数连续调用 ≥4 次 → 干预，防死循环烧 token ----
        const loopHit = detectToolLoop(toolCalls)
        if (loopHit) {
          emitSSE(ctx, 'error', {
            message: `检测到重复调用 ${loopHit.name}（连续 ${loopHit.count} 次相同参数），已干预：要求模型换一种方式完成任务。`,
          })
          messages.push({
            role: 'system',
            content: `警告：你已连续 ${loopHit.count} 次调用 ${loopHit.name} 且参数几乎相同，说明当前方法无效。请立即换一种完全不同的方法完成任务（换工具、换思路、或换参数策略）；如果确实无法完成，直接向用户说明原因并停止，绝不要重复尝试相同操作。`,
          })
        }

        for (const tc of toolCalls) {
          totalToolCalls.push(tc.function.name)
          const isSensitive = SENSITIVE_TOOLS.has(tc.function.name)
          emitSSE(ctx, 'tool_call', {
            name: tc.function.name,
            arguments: tc.function.arguments,
            id: tc.id,
            status: isSensitive ? 'pending' : 'running',
            createTime: Date.now(),  // P0-7：工具真实执行时刻（前端持久化，历史重放订正耗时）
          })
        }

        const assistantMsg: any = {
          role: 'assistant',
        }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls
          // content 在 tool_calls 存在时应省略（不设 null，避免 DeepSeek V4 将其解释为复杂内容类型）
        } else {
          assistantMsg.content = contentBuffer || ''
        }
        if (reasoningBuffer) assistantMsg.reasoning_content = reasoningBuffer
        messages.push(assistantMsg)

        // P0: wrap executeToolCalls with 60s per-tool timeout
        // 敏感工具先确认后执行：挂起等待用户 allow/deny（120s 超时自动拒绝）
        const sensitiveCalls = toolCalls.filter((tc: any) => SENSITIVE_TOOLS.has(tc.function.name))
        const regularCalls = toolCalls.filter((tc: any) => !SENSITIVE_TOOLS.has(tc.function.name))
        let allowSensitive: ('allow' | 'deny')[] = []
        if (sensitiveCalls.length > 0) {
          // 授权模式（settings.toolApprovalMode）：auto=始终允许 / deny=一律拒绝 / prompt=每次询问 / accept-edits=自动批编辑拦命令
          const approvalMode = readSetting('toolApprovalMode') || 'prompt'
          if (approvalMode === 'auto') {
            allowSensitive = sensitiveCalls.map(() => 'allow')
          } else if (approvalMode === 'deny') {
            allowSensitive = sensitiveCalls.map(() => 'deny')
          } else if (approvalMode === 'accept-edits') {
            // AcceptEdits（对齐 WorkBuddy acceptEdits，2026-08-27 加）：自动批准文件编辑(file_write)，拦截危险命令(shell_exec)与删除(file_delete)
            loadSessionApprovals()
            allowSensitive = await Promise.all(
              sensitiveCalls.map((tc: any) => {
                if (tc.function.name === 'file_write') return Promise.resolve('allow' as const)
                if (tc.function.name === 'file_delete') return waitForToolConfirmation(tc.id)
                return waitForToolConfirmation(tc.id) // shell_exec 仍询问
              }),
            )
          } else if (permissionLevel === 'full') {
            // full 权限（对齐 WorkBuddy fullAccess→autoRun）：非删除敏感工具自动放行，基本不弹授权；file_delete 仍确认
            allowSensitive = await Promise.all(
              sensitiveCalls.map((tc: any) =>
                tc.function.name === 'file_delete' ? waitForToolConfirmation(tc.id) : Promise.resolve('allow' as const),
              ),
            )
          } else {
            // 按会话授权（对齐 WorkBuddy 记忆式授权）：本会话已"允许全部"则自动放行所有敏感工具；
            // file_delete 永远确认（"删文件才再授权"的高危体验，老板 2026-08-21）
            loadSessionApprovals()
            allowSensitive = await Promise.all(
              sensitiveCalls.map((tc: any) => {
                if (tc.function.name === 'file_delete') return waitForToolConfirmation(tc.id)
                if (sessionId && sessionApprovedTools.has(sessionId)) {
                  return Promise.resolve('allow' as const)
                }
                return waitForToolConfirmation(tc.id)
              }),
            )
          }
          for (let i = 0; i < sensitiveCalls.length; i++) {
            if (allowSensitive[i] !== 'allow') {
              emitSSE(ctx, 'tool_result', {
                name: sensitiveCalls[i].function.name,
                content: '用户拒绝执行此操作',
                tool_call_id: sensitiveCalls[i].id,
                status: 'denied',
              })
            }
          }
        }
        const executeList = [
          ...regularCalls,
          ...sensitiveCalls.filter((_, i) => allowSensitive[i] === 'allow'),
        ]
        // 会话级工作目录：AI 在用户指定的文件夹里执行文件/命令操作
        // 2026-08-26 修复：工具流式输出限流（防死循环/超大输出刷爆——曾实测单工具 tool_output 6.5 万次=1GB）。
        // 每工具累计超出上限后停止推送该工具的流式块，仅提示一次"已截断"。
        const toolCtx: ToolExecCtx = {
          cwd: sessionWorkspace || undefined,
          permissionLevel,
          // 工具流式输出：分片实时推送（前端 ToolCallBlock 边跑边显示）
          onOutput: (toolCallId, chunk) => {
            const LIMIT = 5 * 1024 * 1024
            const cur = toolStreamBytes.get(toolCallId) || 0
            toolStreamBytes.set(toolCallId, cur + Buffer.byteLength(chunk || '', 'utf-8'))
            if (cur >= LIMIT) {
              // 超出上限：仅首次发截断提示，之后静默丢弃该工具剩余流块
              if (cur < LIMIT + 2048) emitSSE(ctx, 'tool_output', { toolCallId, chunk: `\n[已截断] 输出超过 ${(LIMIT/1024/1024)}MB，已停止流式推送（工具仍在执行，结果会按截断后收集）。` })
              return
            }
            emitSSE(ctx, 'tool_output', { toolCallId, chunk })
          },
          sessionId: sessionId || undefined,
          // AskQuestion：提问挂起等待答复 + 推送给前端展示（options 归一化防模型传对象数组 → 前端 [object Object]，2026-08-27）
          askQuestion: async (qid, question, options) => {
            emitSSE(ctx, 'question', { id: qid, question, options: normalizeQuestionOptions(options) })
            return waitForQuestion(qid)
          },
          emitQuestion: (data) => {
            emitSSE(ctx, 'question', { id: data.id, question: data.question, options: normalizeQuestionOptions(data.options) })
          },
          // 实时预览：写入 html/css/js 文件 → 推送右侧边栏渲染（L1/L2 实时渲染 + 配套资源内联）
          onPreview: (path, content) => {
            emitSSE(ctx, 'preview_update', { path, content })
          },
          // 画图：AI 生成 SVG → 推送聊天内实时渲染
          onDiagram: (title, svg) => {
            emitSSE(ctx, 'diagram', { title, svg })
          },
          // 画图流式块：SVG 标签边界切块推送（"先出画板再逐框绘制"，WorkBuddy 同款）
          onDiagramChunk: (chunk) => {
            emitSSE(ctx, 'diagram_chunk', { chunk })
          },
          // 生图：AI 生成图片 → 推送对话内渲染 + 右侧预览展示
          onImage: (data, isUrl, title) => {
            emitSSE(ctx, 'image_generated', { data, isUrl, title })
          },
          // 文件变更：写入文件 → 推送变更 tab（改前/改后对比）
          onFileChange: (path, oldContent, newContent) => {
            emitSSE(ctx, 'file_changed', { path, oldContent, newContent })
          },
          // shell 命令产生的文件 → 补录产物（持久化 + 实时推送）
          onArtifacts: (files) => {
            if (!sessionId || files.length === 0) return
            for (const f of files) {
              try {
                const existing = db.prepare('SELECT id FROM artifacts WHERE session_id = ? AND path = ?').get(sessionId, f.path) as any
                if (existing) {
                  db.prepare("UPDATE artifacts SET action = 'updated', size = ?, created_at = datetime('now') WHERE id = ?").run(f.size || 0, existing.id)
                } else {
                  const ext = f.name.includes('.') ? f.name.split('.').pop()?.toLowerCase() : ''
                  const mimeMap: Record<string, string> = {
                    md: 'text/markdown', txt: 'text/plain', json: 'application/json',
                    html: 'text/html', css: 'text/css', js: 'application/javascript',
                    ts: 'application/typescript', py: 'text/x-python',
                    png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', csv: 'text/csv',
                  }
                  db.prepare(
                    `INSERT INTO artifacts (id, session_id, name, path, mime, size, action, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
                  ).run(randomUUID(), sessionId, f.name, f.path, mimeMap[ext || ''] || 'text/plain', f.size || 0, f.action)
                }
                emitSSE(ctx, 'file_created', { name: f.name, path: f.path, mime: 'text/plain', size: f.size })
              } catch {}
            }
          },
        }
        const toolResults = await Promise.race([
          executeToolCalls(executeList as any, toolCtx),
          new Promise<any[]>((_, reject) =>
            setTimeout(() => reject(new Error("工具执行超时（60秒）")), 60000)
          ),
        ])

        // 被拒绝的敏感工具调用也注入结果，让 LLM 感知并自主决策
        if (sensitiveCalls.length > 0) {
          for (let i = 0; i < sensitiveCalls.length; i++) {
            if (allowSensitive[i] !== 'allow') {
              messages.push({
                role: 'tool' as const,
                tool_call_id: sensitiveCalls[i].id,
                content: `用户拒绝执行该操作（${sensitiveCalls[i].function.name} 属于敏感操作，未获授权）。请自主判断：
1. 如果任务必须依赖此操作才能完成：向用户说明为什么需要该权限、会做什么，然后停止等待用户授权；
2. 如果存在不需要敏感权限的替代方案：改用非敏感工具完成，不要反复尝试被拒绝的操作；
3. 无论如何不要在未授权时尝试绕过权限限制。`,
              })
            }
          }
        }

        for (const result of toolResults) {
          const tc = toolCalls.find((t: any) => t.id === result.tool_call_id)
          const toolName = tc?.function?.name || 'unknown'
          emitSSE(ctx, 'tool_result', {
            name: toolName,
            content: result.content.slice(0, 500),
            tool_call_id: result.tool_call_id,
          })
          if (result.duration) {
            emitSSE(ctx, 'tool_duration', { name: toolName, duration: result.duration, tool_call_id: result.tool_call_id })
          }
          messages.push(result)

          // ---- 工具循环防护：签名级追踪 ----
          const toolArgs = tc?.function?.arguments || ''
          const guardResult = guardrail.recordResult(toolName, toolArgs, result.content)
          if (guardResult.decision === 'halt') {
            emitSSE(ctx, 'tool_guardrail', { decision: 'halt', toolName, message: guardResult.message })
            messages.push({ role: 'system', content: guardResult.message! })
            // halt 意味着这个工具完全不能用了，但不终止整个循环，让模型换方法
          } else if (guardResult.decision === 'block') {
            emitSSE(ctx, 'tool_guardrail', { decision: 'block', toolName, message: guardResult.message })
            messages.push({ role: 'system', content: guardResult.message! })
          } else if (guardResult.decision === 'warn') {
            emitSSE(ctx, 'tool_guardrail', { decision: 'warn', toolName, message: guardResult.message })
            messages.push({ role: 'system', content: guardResult.message! })
          }

          if (toolName === 'file_write') {
            try {
              const args = JSON.parse(tc?.function?.arguments || '{}')
              const filePath = args.path || args.file_path || args.filePath
              if (filePath) {
                const parts = filePath.split('/')
                const name = parts[parts.length - 1] || filePath
                const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : ''
                const mimeMap: Record<string, string> = {
                  md: 'text/markdown', txt: 'text/plain', json: 'application/json',
                  html: 'text/html', css: 'text/css', js: 'application/javascript',
                  ts: 'application/typescript', py: 'text/x-python',
                  png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml',
                }
                const fileInfo = { name, path: filePath, mime: mimeMap[ext || ''] || 'text/plain', size: (tc?.function?.arguments?.length || result.content?.length) }
                createdFiles.push(fileInfo)
                emitSSE(ctx, 'file_created', fileInfo)
                // 持久化产物（会话级）：刷新页面后仍能在会话里看到 AI 生成的文件
                if (sessionId) {
                  try {
                    const action = existsSync(filePath) ? 'updated' : 'created'
                    db.prepare(
                      `INSERT INTO artifacts (id, session_id, name, path, mime, size, action, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
                    ).run(randomUUID(), sessionId, name, filePath, fileInfo.mime, fileInfo.size || 0, action)
                  } catch {}
                }
              }
            } catch {}
          }

          // ---- Plan 进度推进（横栏任务胶囊）：每轮工具调用后，当前步骤 completed → 下一步 in_progress ----
          if (sessionId) {
            const hasCreatePlan = toolCalls.some((tc: any) => tc.function?.name === 'create_plan')
            if (hasCreatePlan) {
              // 本轮创建了计划：推送初始快照（第一步已 in_progress）
              const snap = getPlanSnapshot(sessionId)
              if (snap) emitSSE(ctx, 'plan_update', snap)
            } else {
              const snap = advancePlan(sessionId)
              if (snap) emitSSE(ctx, 'plan_update', snap)
            }
          }
        }
      } else {
        // ---- 空内容兜底：模型只返回 reasoning 没有实际内容 ----
        if (!contentBuffer || contentBuffer.trim().length === 0) {
          // 纯推理轮（无正文无工具）不是"收尾确认"——可能是模型在思考下一步。
          // 修复：不因 hasProducedContent 直接结束（会误杀未完成任务），允许最多 2 次重试
          if (emptyContentCount >= 2) {
            // 连续多次纯推理 → 用 reasoning 摘要兜底（保证用户至少看到内容）
            let fallbackContent = '抱歉，模型未能生成回复。请重试或换个问法。'
            if (reasoningBuffer && reasoningBuffer.length > 50) {
              // 从 reasoning 中提取可能的有用内容（去掉思考过程的前缀）
              const cleaned = reasoningBuffer
                .replace(/^思考中\.\.\./, '')
                .replace(/^第 \d+\/\d+ 轮思考\.\.\./, '')
                .trim()
              if (cleaned.length > 30) {
                fallbackContent = `*（模型进行了推理但未生成格式化回复，以下是推理摘要）*\n\n${cleaned.slice(0, 800)}${cleaned.length > 800 ? '...' : ''}`
              }
            }
            emitSSE(ctx, 'content', { content: fallbackContent })
            finished = true
            break
          }
          emptyContentCount++
          // 推回让模型继续：任务未完成则继续调工具，已完成则输出最终结论
          emitSSE(ctx, 'empty_content_retry', { attempt: emptyContentCount })
          messages.push({
            role: 'system',
            content: '你的上一条回复只有内部推理、没有任何实际输出（没有正文也没有调用工具）。如果任务已经完成，请直接输出最终结论正文；如果任务尚未完成，请继续调用工具完成剩余步骤，不要提前结束。',
          })
          continue  // 重试（最多 2 次）
        }

        // ---- 非空内容：正常收尾 ----
        finished = true
        emitSSE(ctx, 'content', { content: contentBuffer })

        const finalMsg: AgentMessage = { role: 'assistant', content: contentBuffer }
        if (reasoningBuffer) finalMsg.reasoning_content = reasoningBuffer
        messages.push(finalMsg)

        await autoExtractMemories(contentBuffer, lastUserContent)
        // Memory sync_turn + Experience Reflection：收拢到后台 worker 串行提取（2026-08-28 改，
        // 原 fire-and-forget 每轮开一个 LLM 提取调用，高频对话会堆积并发 → 单 worker 串行节流）
        pushMemorySync(lastUserContent, contentBuffer)
        const reflectTools = [...totalToolCalls]
        pushReflection({ userContent: lastUserContent, toolCalls: reflectTools, summary: contentBuffer.slice(0, 3000) })
      }

      // 本轮结束：把真实 token 用量发给前端（有 usage 时），cost 按模型单价估算
      if (lastUsage && lastUsage.total_tokens) {
        emitSSE(ctx, 'usage', {
          promptTokens: lastUsage.prompt_tokens || 0,
          completionTokens: lastUsage.completion_tokens || 0,
          totalTokens: lastUsage.total_tokens || 0,
          cost: estimateCost(agentConfig.model, lastUsage),
        })
      }

      // ---- P0: 中间检查点 ----
      if (!finished && turn - lastCheckpointTurn >= TURN_CONFIG.CHECKPOINT_INTERVAL) {
        lastCheckpointTurn = turn
        const checkpoint: AgentCheckpoint = {
          id: checkpointId,
          turn,
          messages: [...messages],
          createdFiles: [...createdFiles],
          totalToolCalls: [...totalToolCalls],
          timestamp: new Date().toISOString(),
        }
        const ckptPath = await saveCheckpoint(checkpoint)
        emitSSE(ctx, 'checkpoint', {
          turn,
          path: ckptPath,
          files: createdFiles.length,
          toolCalls: totalToolCalls.length,
        })
      }
    } catch (err: any) {
      const classified = classifyApiError(err)
      console.warn(`[Agent] Error (${classified.reason}): ${classified.message.slice(0, 200)}`)

      // ---- 上下文溢出：压缩后重试 ----
      if (classified.shouldCompress && compressionAttempts < 3) {
        compressionAttempts++
        emitSSE(ctx, 'compressing', { attempt: compressionAttempts, reason: classified.reason })
        const baseUrl = agentConfig.baseUrl || config.deepseek.baseUrl
        const result = await compressContext(messages, agentConfig.apiKey, baseUrl)
        if (result.compressed) {
          messages = result.messages as AgentMessage[]
          emitSSE(ctx, 'compressed', { savedTokens: result.savedTokens })
          continue  // 压缩后重试
        }
      }

      // ---- 需要 fallback：通知用户但不重试 ----
      if (classified.shouldFallback) {
        emitSSE(ctx, 'error', {
          message: `[${classified.reason}] ${classified.message.slice(0, 200)}`,
          needFallback: true,
          reason: classified.reason,
        })
        emitSSE(ctx, 'content', {
          content: `API 服务异常 (${classified.reason})，建议切换模型或稍后重试。\n\n详情: ${classified.message.slice(0, 300)}`,
          error: true,
        })
        interrupted = classified.reason  // 2026-08-26：费用耗尽/需切换模型 → 中断，保存检查点
        finished = true
        break
      }

      // ---- 可重试：退避后继续 ----
      if (classified.retryable) {
        consecutiveApiErrors++
        if (consecutiveApiErrors > 3) {
          emitSSE(ctx, 'error', { message: `连续 ${consecutiveApiErrors} 次失败 (${classified.reason})，停止重试` })
          emitSSE(ctx, 'content', {
            content: `抱歉，连续 ${consecutiveApiErrors} 次 API 失败 (${classified.reason})。请稍后再试。\n\n错误: ${classified.message.slice(0, 300)}`,
            error: true,
          })
          interrupted = classified.reason  // 2026-08-26：连续 API 失败 → 中断，保存检查点
          finished = true
        } else {
          const backoffMs = jitteredBackoff(consecutiveApiErrors)
          emitSSE(ctx, 'error', {
            message: `${classified.reason} (${consecutiveApiErrors}/3)，${Math.round(backoffMs/1000)}s 后重试...`,
            retrying: true,
            reason: classified.reason,
          })
          await new Promise(r => setTimeout(r, backoffMs))
          continue
        }
      } else {
        // 不可重试的错误
        emitSSE(ctx, 'error', { message: `[${classified.reason}] ${classified.message.slice(0, 200)}` })
        emitSSE(ctx, 'content', { content: `执行出错 (${classified.reason}): ${classified.message.slice(0, 300)}`, error: true })
        interrupted = classified.reason  // 2026-08-26：不可重试错误 → 中断，保存检查点
        finished = true
      }
    }
  }

  // ---- P0: 超限/中断处理 ----
  // 2026-08-26：中断（API 费用耗尽/连续失败/不可重试）也保存检查点，保证可续跑。
  // 超限（!finished 且未中断）→ 原有 maxTurns 提示；中断（interrupted）→ 提示可切换模型继续。
  if (!finished || interrupted) {
    // 保存检查点（中断/超限/正常收尾前都保留进度）
    const finalCheckpoint: AgentCheckpoint = {
      id: checkpointId,
      turn,
      messages: [...messages],
      createdFiles: [...createdFiles],
      totalToolCalls: [...totalToolCalls],
      timestamp: new Date().toISOString(),
    }
    const ckptPath = await saveCheckpoint(finalCheckpoint)

    if (interrupted) {
      // API 中断：发 checkpoint_available 事件，前端据此显示"继续"按钮
      emitSSE(ctx, 'checkpoint_available', {
        turns: turn,
        checkpointId,
        checkpointPath: ckptPath,
        createdFiles: createdFiles.map(f => ({ name: f.name, path: f.path, mime: f.mime })),
        toolCallCount: totalToolCalls.length,
        message: `任务因 ${interrupted || 'API 异常'} 中断，已保存进度。可切换模型后继续（${turn} 轮进程已保留）。`,
      })
    } else {
      // 超限：原有 turn_limit_reached 提示
      emitSSE(ctx, 'turn_limit_reached', {
        turns: turn,
        maxTurns: effectiveMaxTurns,
        checkpointPath: ckptPath,
        checkpointId,
        createdFiles: createdFiles.map(f => ({ name: f.name, path: f.path, mime: f.mime })),
        toolCallCount: totalToolCalls.length,
        message: `已达 ${effectiveMaxTurns} 轮上限。已保存检查点，可在 Settings 调整 maxTurns 后继续。`,
      })
      emitSSE(ctx, 'content', {
        content: `📋 **任务进行到第 ${turn}/${effectiveMaxTurns} 轮，未完成。**

| 信息 | 值 |
|------|-----|
| 检查点 ID | \`${checkpointId}\` |
| 已产生文件 | ${createdFiles.length} 个 |
| 工具调用 | ${totalToolCalls.length} 次 |
| 上次检查点 | 第 ${lastCheckpointTurn} 轮 |

**如何继续？** 在 Settings → Agent 里调大 maxTurns（建议 60+），然后发送 \`继续检查点 ${checkpointId}\` 接着跑。`,
      })
    }
  }

  if (createdFiles.length > 0) {
    emitSSE(ctx, 'delivery_summary', {
      artifacts: createdFiles.map(f => ({ name: f.name, path: f.path, mime: f.mime })),
      artifactCount: createdFiles.length,
      toolCallCount: totalToolCalls.length,
      turns: turn,
    })
  }

  // ---- 画图兜底：用户要画图但 AI 没输出 SVG（也没调 draw_diagram）→ 自动补一次 LLM 生成图 ----
  // 注意：必须在 done 之前同步等待，否则 SSE 响应关闭后图推不出去（ctx.res.writable=false）
  if (isDrawingRequest(lastUserContent)) {
    const lastMsg = messages[messages.length - 1]
    const lastContent = typeof lastMsg?.content === 'string' ? lastMsg.content : ''
    const usedDrawTool = totalToolCalls.includes('draw_diagram')
    if (!usedDrawTool && !lastContent.includes('<svg')) {
      try {
        const svg = await generateSvgFor(lastContent, lastUserContent, agentConfig.apiKey, agentConfig.baseUrl || config.deepseek.baseUrl)
        if (svg) {
          console.log(`[DrawFallback] 自动生成 SVG 图 (${svg.length} 字符)`)
          emitSSE(ctx, 'diagram', { title: '', svg })
        }
      } catch { /* 兜底失败不影响主流程 */ }
    }
  }

  // 2026-08-26：任务收尾自动写日志 .md（老板需求）——统一出口，简单/复杂任务都写。
  // 放此统一收尾点（画图兜底后、routine 前），summary 取 messages 最后一条 assistant 内容。
  {
    const lastMsg = messages[messages.length - 1]
    const lastContent = typeof lastMsg?.content === 'string' ? lastMsg.content : ''
    appendTaskLog({
      userContent: lastUserContent,
      summary: lastContent,
      toolCount: totalToolCalls.length,
      turns: turn,
      model: agentConfig.model,
    }).catch((e) => console.log(`[TaskLog] 异常: ${e?.message || e}`))
  }

  // ---- Routine 推荐（学 Grok"演示一次就学会"）：复杂任务完成后主动建议保存为可复用流程 ----
  // 条件：≥3 次工具调用 + ≥3 轮 + 任务正常完成；必须在 done 之前发送
  if (finished && turn >= 3 && totalToolCalls.length >= 3) {    try {
      const uniqueTools = [...new Set(totalToolCalls)].slice(0, 8)
      emitSSE(ctx, 'routine_suggest', {
        sessionId: sessionId || '',
        title: (lastUserContent || '未命名任务').slice(0, 40),
        toolSummary: uniqueTools,
        toolCount: totalToolCalls.length,
        turnCount: turn,
      })
    } catch { /* 推荐失败不影响主流程 */ }
  }

  // ---- Plan 收尾：任务结束，全部步骤标记完成（横栏胶囊全部划线） ----
  if (sessionId) {
    try {
      const snap = finishPlan(sessionId)
      if (snap) emitSSE(ctx, 'plan_update', snap)
    } catch { /* 收尾失败不影响主流程 */ }
  }

  emitSSE(ctx, 'done', { turns: turn, maxTurns: effectiveMaxTurns, finished, summary: createdFiles.length > 0 ? `任务完成，共产生 ${createdFiles.length} 个文件` : undefined })

  // ---- Playbook: 复杂任务完成后异步生成执行复盘（不阻塞主流程） ----
  if (turn >= 3 && totalToolCalls.length > 0) {
    const lastMsg = messages[messages.length - 1]
    const lastContent = typeof lastMsg?.content === 'string' ? lastMsg.content : ''
    generatePlaybook({
      userTask: lastUserContent,
      tools: [...totalToolCalls],
      turns: turn,
      files: createdFiles.length,
      lastContent,
      apiKey: agentConfig.apiKey,
      baseUrl: agentConfig.baseUrl || config.deepseek.baseUrl,
      checkpointId,
      roleName: activeRole?.name || '',
    }).catch(() => { /* 复盘生成失败不影响主流程 */ })
  }

  // ---- 技能进化（进化闭环）：复杂任务 → 自动提炼成 SKILL.md；失败+用过技能 → 自动修补 ----
  if (turn >= 3 && totalToolCalls.length > 0) {
    const lastMsg = messages[messages.length - 1]
    const lastContent = typeof lastMsg?.content === 'string' ? lastMsg.content : ''
    const evolveOpts = {
      userTask: lastUserContent,
      tools: [...totalToolCalls],
      turns: turn,
      files: createdFiles.length,
      lastContent,
      apiKey: agentConfig.apiKey,
      baseUrl: agentConfig.baseUrl || config.deepseek.baseUrl,
      workspaceDir: sessionWorkspace || config.workspaceDir,
      roleName: activeRole?.name || '',
    }
    // 闭环 B：自动技能创建（内部有触发门槛：5+ 工具 & 5+ 轮）
    maybeCreateSkill(evolveOpts).catch(() => {})
    // 闭环 C：技能自修补（任务失败且本轮用过技能）
    if (!finished) {
      const usedSkills = (systemPrompt.matchedSkills || []).map((s) => s.name)
      if (usedSkills.length > 0) {
        maybeRepairSkill({ ...evolveOpts, usedSkills, failureReason: `任务未完成（finished=false，${turn} 轮）` }).catch(() => {})
      }
    }
  }
}

/** 画图请求关键词检测 */
const DRAW_REQUEST_RE = /画|图|架构|流程|示意|图表|diagram|chart|architect|flowchart|illustration/i
function isDrawingRequest(text: string): boolean {
  return DRAW_REQUEST_RE.test(text || '')
}

/**
 * 画图兜底：deepseek 等模型可能拒绝主动输出 SVG，任务结束后用一次独立 LLM 调用
 * 把回答内容转成 SVG 图（直接输出 <svg>，不依赖模型自觉）。
 */
async function generateSvgFor(content: string, task: string, apiKey: string, baseUrl: string): Promise<string | null> {
  try {
    const prompt = `用户要求画图，但之前的回答没有包含真正的图。请把回答内容画成一张 SVG 图。

用户需求: ${(task || '').slice(0, 200)}

回答内容: ${(content || '').slice(0, 1200)}

要求：直接输出 SVG 代码（以 <svg 开头，不要文字、不要代码块标记、不要 markdown）。viewBox="0 0 680 420"，用 rect/circle/text/path 等元素，文字必须有 fill 颜色，配色清晰。`
    const text = await chatCompletion({
      baseUrl,
      apiKey,
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      maxTokens: 2000,
    })
    if (!text) return null
    const m = text.match(/<svg[\s\S]*?<\/svg>/)
    if (!m) return null
    // 安全校验：禁 script/事件/外链
    if (/<script|on\w+=|javascript:|href=|<foreignObject/i.test(m[0])) return null
    return m[0]
  } catch {
    return null
  }
}

/**
 * Playbook 复盘生成：用便宜模型把一次任务执行提炼为可复用经验，存入 playbook 表
 */
async function generatePlaybook(opts: {
  userTask: string
  tools: string[]
  turns: number
  files: number
  lastContent: string
  apiKey: string
  baseUrl: string
  checkpointId: string
  roleName?: string
}) {
  const db = getDB()
  const prompt = `你是任务复盘专家。根据以下 Agent 任务执行记录，提炼一条可复用的中文经验（≤120字），并给出任务类型标签。

任务: ${opts.userTask.slice(0, 200)}
执行轮数: ${opts.turns}
工具调用序列: ${opts.tools.join(' → ')}
产出文件: ${opts.files} 个
最终结果: ${opts.lastContent.slice(0, 300)}

严格输出 JSON（不要其他文字）:
{"taskType": "简短任务类型标签，4-8字，如 代码审计/数据分析/网页抓取", "lesson": "关键经验：这次怎么做的、卡在哪里、下次同类任务应该怎么走更快"}`

  try {
    const text = await chatCompletion({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      maxTokens: 300,
    })
    if (!text) return
    let parsed: any = null
    try {
      parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
    } catch {
      const m = text.match(/\{[\s\S]*\}/)
      if (m) { try { parsed = JSON.parse(m[0]) } catch {} }
    }
    if (!parsed || !parsed.lesson) return

    db.prepare(
      `INSERT INTO playbook (id, task_type, lesson, tools_used, turns, tool_calls, session_id, checkpoint_id, role_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(
      randomUUID(),
      String(parsed.taskType || '通用任务').slice(0, 30),
      String(parsed.lesson).slice(0, 500),
      JSON.stringify(opts.tools),
      opts.turns,
      opts.tools.length,
      null,
      opts.checkpointId,
      opts.roleName || '',
    )
    console.log(`[Playbook] 已生成经验: [${String(parsed.taskType || '通用任务').slice(0, 20)}] ${String(parsed.lesson).slice(0, 40)}...`)
  } catch { /* ignore */ }
}

/**
 * 自动从对话中提取重要信息并存储为记忆
 */
async function autoExtractMemories(assistantContent: string, userContent: string) {
  const db = getDB()

  // 记忆开关关闭时不提取
  const memoryEnabledRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryEnabled') as any
  if (memoryEnabledRow && memoryEnabledRow.value !== 'true') return

  const memoryPatterns = [
    { pattern: /我叫\s*(\S+)/, key: '用户名称', category: 'preference' },
    { pattern: /我是\s*(.+)/, key: '用户身份', category: 'fact' },
    { pattern: /用\s*(.+)\s*语言/, key: '偏好语言', category: 'preference' },
    { pattern: /项目[名称是]*\s*[：:]\s*(.+)/, key: '项目名称', category: 'fact' },
    { pattern: /喜欢\s*(.+)/, key: '用户偏好', category: 'preference' },
  ]

  const combinedText = userContent + ' ' + assistantContent

  for (const { pattern, key, category } of memoryPatterns) {
    const match = combinedText.match(pattern)
    if (match && match[1]) {
      const existing = db.prepare('SELECT id FROM agent_memory WHERE key = ?').get(key) as any
      if (!existing) {
        const id = randomUUID()
        db.prepare(
          'INSERT INTO agent_memory (id, key, content, category, importance) VALUES (?, ?, ?, ?, ?)'
        ).run(id, key, match[1], category, 3)
      }
    }
  }
}
