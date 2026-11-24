import { EventEmitter } from 'node:events'
import type { Context } from 'koa'
import type { GoalRunner } from './goal-coordinator'
import { parseGoalTurnReport } from './goal-turn-report'

type AgentHandler = (ctx: Context) => Promise<void>

/** Bridge a locally owned goal run into the regular Agent entry point. */
export function makeGoalAgentRunner(options: {
  handler: AgentHandler
  requestStop: (sessionId: string) => unknown
  makeMessages: (sessionId: string, objective: string, acceptance: string) => Promise<Array<{ role: string; content: string }>>
  ownerIsCurrent: () => boolean
  onAccountChange?: (listener: () => void) => () => void
}): GoalRunner {
  return async ({ goal, signal, emit, options: executionOptions }) => {
    if (signal.aborted || !options.ownerIsCurrent()) return { outcome: 'interrupted', summary: '执行尚未开始或账号已变更。' }
    const messages = await options.makeMessages(goal.session_id, goal.objective, goal.acceptance)
    if (signal.aborted || !options.ownerIsCurrent()) return { outcome: 'interrupted', summary: '执行尚未开始或账号已变更。' }
    let started = false, doneSeen = false, finished = false, terminal = '', answer = '', chunks = '', captureFailed = false, checkpointInterrupted = false
    let hadInteraction = false, hadToolFailure = false, accountChanged = false
    const calls = new Map<string, { name: string; arguments: string }>()
    const results = new Map<string, { content: string; denied: boolean }>()
    const stop = () => { if (started) options.requestStop(goal.session_id) }
    signal.addEventListener('abort', stop)
    const unsubscribeAccount = options.onAccountChange?.(() => {
      let current = false
      try { current = options.ownerIsCurrent() } catch { /* unreadable account state fails closed */ }
      if (!current) { accountChanged = true; stop() }
    })
    const response = new EventEmitter() as EventEmitter & { write: (data: unknown) => boolean; end: () => void; writableEnded: boolean }
    let pendingFrame = ''
    response.writableEnded = false
    response.write = data => {
      pendingFrame += String(data)
      let boundary: RegExpExecArray | null
      while ((boundary = /\r?\n\r?\n/.exec(pendingFrame))) {
        const frame = pendingFrame.slice(0, boundary.index)
        pendingFrame = pendingFrame.slice(boundary.index + boundary[0].length)
        if (Buffer.byteLength(frame, 'utf8') > 256 * 1024) { captureFailed = true; stop(); continue }
        const name = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim()
        const raw = /^data:\s*(.+)$/m.exec(frame)?.[1]
        if (!name && !raw) continue // heartbeat/comment
        if (!name || !raw) { captureFailed = true; stop(); continue }
        let payload: Record<string, unknown>
        try { payload = JSON.parse(raw) } catch { captureFailed = true; stop(); continue }
        if (name === 'config') { started = true; if (signal.aborted) stop() }
        if (accountChanged || !options.ownerIsCurrent()) { accountChanged = true; captureFailed = true; stop(); continue }
        try { emit(name, payload) } catch { captureFailed = true; stop(); continue }
        if (name === 'question' || (name === 'tool_result' && payload.status === 'denied')) hadInteraction = true
        if (name === 'tool_result' && ['failed', 'error', 'cancelled'].includes(String(payload.status))) { hadToolFailure = true; hadInteraction = true }
        if (name === 'tool_call' && typeof payload.id === 'string' && typeof payload.name === 'string') calls.set(payload.id, { name: payload.name, arguments: String(payload.arguments || '') })
        if (name === 'tool_result' && typeof payload.tool_call_id === 'string' && typeof payload.content === 'string') results.set(payload.tool_call_id, { content: payload.content, denied: ['denied', 'failed', 'error', 'cancelled'].includes(String(payload.status)) })
        if (name === 'content' && typeof payload.content === 'string') answer = payload.content
        if (name === 'content_chunk' && typeof payload.text === 'string') chunks += payload.text
        if (name === 'task_state' && typeof payload.status === 'string') terminal = payload.status
        if (name === 'checkpoint_available' || name === 'turn_limit_reached') checkpointInterrupted = true
        if (name === 'done') { doneSeen = true; finished = payload.finished === true }
      }
      if (Buffer.byteLength(pendingFrame, 'utf8') > 256 * 1024) { pendingFrame = ''; captureFailed = true; stop() }
      return true
    }
    response.end = () => { response.writableEnded = true; response.emit('finish') }
    const ctx = { state: { goalExecution: true }, request: { body: { messages, sessionId: goal.session_id, model: executionOptions?.model, language: executionOptions?.language } }, req: new EventEmitter(), res: response, set: () => {} } as unknown as Context
    try { await options.handler(ctx) } finally { signal.removeEventListener('abort', stop); unsubscribeAccount?.() }
    // The account can change after the final event but before the handler exits.
    // Never settle that run as a normal result for a different account.
    if (accountChanged || !options.ownerIsCurrent()) return { outcome: 'interrupted', summary: '执行期间账号已变更，请检查原账号下的进度。' }
    if (captureFailed || pendingFrame.trim() || !doneSeen || ['failed', 'interrupted'].includes(terminal)) return { outcome: 'interrupted', summary: '执行中断或事件未能保存，请检查进度。' }
    if (signal.aborted || terminal === 'paused' || terminal === 'cancelled') return { outcome: 'paused', summary: answer || chunks || '已停止。' }
    if (!finished || checkpointInterrupted) return { outcome: 'interrupted', summary: answer || chunks || '执行中断，请检查进度。' }
    if (terminal === 'waiting_user') return { outcome: 'waiting_user', summary: answer || chunks || '等待用户操作。' }
    // A finished Agent turn is not proof that the overall objective is complete.
    const report = parseGoalTurnReport(answer || chunks, calls, results, hadInteraction)
    const summary = report.summary || '本轮结束，请核实目标进度。'
    return { outcome: 'paused', summary: hadToolFailure ? `本轮有工具执行失败或未执行，以下结果需要核实：\n${summary}` : summary, ...(report.fingerprint ? { progressFingerprint: report.fingerprint } : {}) }
  }
}
