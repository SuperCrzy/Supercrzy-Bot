/**
 * Hooks System — 会话生命周期事件钩子
 * SessionStart, SessionEnd, MessageReceived, MessageSent, Error
 */
import { getDB } from './database'
import { analyzeMessages, summarizeSession } from './continuous-learning'
import { scanContent, sanitizeContent } from './security-shield'

type HookName = 'SessionStart' | 'SessionEnd' | 'MessageReceived' | 'MessageSent' | 'BeforeSend' | 'Error'

interface HookContext {
  sessionId: string
  userId?: string
  messages?: Array<{ role: string; content: string }>
  currentMessage?: { role: string; content: string }
  error?: Error
}

type HookFn = (ctx: HookContext) => Promise<void> | void

const hooks = new Map<HookName, HookFn[]>()
const activeSessions = new Map<string, { messages: Array<{ role: string; content: string }>; userId: string; startedAt: number }>()

// 注册钩子
export function registerHook(event: HookName, fn: HookFn) {
  if (!hooks.has(event)) hooks.set(event, [])
  hooks.get(event)!.push(fn)
}

// 触发钩子
export async function triggerHook(event: HookName, ctx: HookContext) {
  const fns = hooks.get(event)
  if (!fns) return
  for (const fn of fns) {
    try { await fn(ctx) } catch (e) { /* hook error should not break main flow */ }
  }
}

// ── 内置钩子 ──

// SessionStart: 初始化会话追踪
registerHook('SessionStart', (ctx) => {
  activeSessions.set(ctx.sessionId, {
    messages: [],
    userId: ctx.userId || 'unknown',
    startedAt: Date.now(),
  })
})

// MessageReceived: 记录消息 + 安全检查
registerHook('MessageReceived', async (ctx) => {
  const session = activeSessions.get(ctx.sessionId)
  if (session && ctx.currentMessage) {
    session.messages.push(ctx.currentMessage)
    
    // 安全检查用户输入
    const scan = scanContent(ctx.currentMessage.content, 'user_input')
    if (scan.alerts.length > 0) {
      console.log(`[Shield] User message alerts (${ctx.sessionId.slice(0, 8)}):`, scan.alerts.map(a => a.rule))
    }
  }
})

// BeforeSend: 安全检查 + 内容清理
registerHook('BeforeSend', async (ctx) => {
  if (ctx.currentMessage) {
    // 扫描要发送的内容
    const scan = scanContent(ctx.currentMessage.content, 'agent_response')
    if (!scan.safe) {
      console.warn(`[Shield] BLOCKED critical leak in response (${ctx.sessionId.slice(0, 8)})`)
      ctx.currentMessage.content = sanitizeContent(ctx.currentMessage.content)
    }
  }
})

// SessionEnd: 持续学习 + 清理
registerHook('SessionEnd', async (ctx) => {
  const session = activeSessions.get(ctx.sessionId)
  if (session && session.messages.length > 0) {
    // 运行持续学习
    try {
      const insights = analyzeMessages(session.messages, ctx.sessionId)
      if (insights.length > 0) {
        console.log(`[Learn] Extracted ${insights.length} insights from session ${ctx.sessionId.slice(0, 8)}`)
      }
      
      // 保存会话摘要
      const summary = summarizeSession(session.messages)
      const db = getDB()
      db.prepare(
        'UPDATE sessions SET title = ? WHERE id = ?'
      ).run(summary.slice(0, 100), ctx.sessionId)
    } catch (e) { /* non-critical */ }
  }
  
  activeSessions.delete(ctx.sessionId)
})

// ── 公用函数 ──

// 中间件包装器：在会话期间自动管理生命周期
export function withSession(sessionId: string, userId: string, handler: () => Promise<any>) {
  return async () => {
    await triggerHook('SessionStart', { sessionId, userId })
    try {
      const result = await handler()
      return result
    } catch (e: any) {
      await triggerHook('Error', { sessionId, userId, error: e })
      throw e
    } finally {
      await triggerHook('SessionEnd', { sessionId, userId, messages: activeSessions.get(sessionId)?.messages })
    }
  }
}

// 发送消息前的安全包装
export async function safeSend(ctx: { sessionId: string; content: string; role: string }) {
  await triggerHook('MessageReceived', { sessionId: ctx.sessionId, currentMessage: { role: ctx.role, content: ctx.content } })
  
  let safeContent = ctx.content
  await triggerHook('BeforeSend', { 
    sessionId: ctx.sessionId, 
    currentMessage: { role: ctx.role, content: safeContent } 
  })
  
  return safeContent
}
