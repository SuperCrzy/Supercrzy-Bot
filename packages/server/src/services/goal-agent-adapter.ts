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
}): GoalRunner {
  return async ({ goal, signal, emit }) => {
    if (signal.aborted || !options.ownerIsCurrent()) return { outcome: 'interrupted', summary: '执行尚未开始或账号已变更。' }
    const messages = await options.makeMessages(goal.session_id, goal.objective, goal.acceptance)
    if (signal.aborted || !options.ownerIsCurrent()) return { outcome: 'interrupted', summary: '执行尚未开始或账号已变更。' }
    let started = false, done = false, terminal = '', answer = '', chunks = '', captureFailed = false
    let hadInteraction = false
    const calls = new Map<string, { name: string; arguments: string }>()
    const results = new Map<string, { content: string; denied: boolean }>()
    const stop = () => { if (started) options.requestStop(goal.session_id) }
    signal.addEventListener('abort', stop)
    const response = new EventEmitter() as EventEmitter & { write: (data: unknown) => boolean; end: () => void; writableEnded: boolean }
    response.writableEnded = false
    response.write = data => {
      for (const frame of String(data).split('\n\n')) {
        const name = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim()
        const raw = /^data:\s*(.+)$/m.exec(frame)?.[1]
        if (!name || !raw) continue
        let payload: Record<string, unknown>
        try { payload = JSON.parse(raw) } catch { captureFailed = true; stop(); continue }
        if (name === 'config') { started = true; if (signal.aborted) stop() }
        if (!options.ownerIsCurrent()) { captureFailed = true; stop(); continue }
        try { emit(name, payload) } catch { captureFailed = true; stop(); continue }
        if (name === 'question' || (name === 'tool_result' && payload.status === 'denied')) hadInteraction = true
        if (name === 'tool_call' && typeof payload.id === 'string' && typeof payload.name === 'string') calls.set(payload.id, { name: payload.name, arguments: String(payload.arguments || '') })
        if (name === 'tool_result' && typeof payload.tool_call_id === 'string' && typeof payload.content === 'string') results.set(payload.tool_call_id, { content: payload.content, denied: payload.status === 'denied' })
        if (name === 'content' && typeof payload.content === 'string') answer = payload.content
        if (name === 'content_chunk' && typeof payload.text === 'string') chunks += payload.text
        if (name === 'task_state' && typeof payload.status === 'string') terminal = payload.status
        if (name === 'checkpoint_available' || name === 'turn_limit_reached') terminal = 'interrupted'
        if (name === 'done') done = payload.finished === true
      }
      return true
    }
    response.end = () => { response.writableEnded = true; response.emit('finish') }
    const ctx = { state: { goalExecution: true }, request: { body: { messages, sessionId: goal.session_id } }, req: new EventEmitter(), res: response, set: () => {} } as unknown as Context
    try { await options.handler(ctx) } finally { signal.removeEventListener('abort', stop) }
    if (captureFailed || !done || ['failed', 'interrupted'].includes(terminal)) return { outcome: 'interrupted', summary: '执行中断或事件未能保存，请检查进度。' }
    if (signal.aborted || terminal === 'paused' || terminal === 'cancelled') return { outcome: 'paused', summary: answer || chunks || '已停止。' }
    if (terminal === 'waiting_user') return { outcome: 'waiting_user', summary: answer || chunks || '等待用户操作。' }
    // A finished Agent turn is not proof that the overall objective is complete.
    const report = parseGoalTurnReport(answer || chunks, calls, results, hadInteraction)
    return { outcome: 'paused', summary: report.summary || '本轮结束，请核实目标进度。', ...(report.fingerprint ? { progressFingerprint: report.fingerprint } : {}) }
  }
}
