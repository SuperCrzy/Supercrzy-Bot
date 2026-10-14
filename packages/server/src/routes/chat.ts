import Router from 'koa-router'
import { handleStreamChat, handleChat, handleAgentChat, handleCompareChat, handleCompareStreamChat } from '../services/chat'
import { resolveToolConfirmation, approveSessionTools, resolveQuestion, requestStop, clearStop, isStopRequested } from '../services/agent'
import { getTaskBySession, requestTaskCancel, requestTaskPause, resumeTask } from '../services/task-state'

export const chatRouter = new Router({ prefix: '/api/chat' })

chatRouter.post('/stream', handleStreamChat)
chatRouter.post('/agent', handleAgentChat)
chatRouter.post('/compare', handleCompareChat)
chatRouter.post('/compare-stream', handleCompareStreamChat)
chatRouter.post('/', handleChat)

// 停止正在运行的 Agent（2026-08-28 加：此前无停止机制，失控任务只能干等跑满 maxTurns）
// body: { sessionId } —— 与 /api/chat/agent 传入的 sessionId 一致
chatRouter.post('/stop', async (ctx) => {
  const { sessionId } = (ctx.request.body as any) || {}
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { error: 'sessionId is required' }
    return
  }
  requestStop(String(sessionId))
  // P0-03：同时写统一状态机的 cancel_requested_at —— 用户点了停止，但循环可能还在跑，
  // 此时状态仍是 running 且带取消标记，UI 显示"正在停止…"而非"已停止"。
  let cancelling = false
  try {
    const t = getTaskBySession(String(sessionId))
    if (t) cancelling = requestTaskCancel(t.task_id)
  } catch { /* 不影响停止主流程 */ }
  ctx.body = { ok: true, stopped: true, sessionId: String(sessionId), cancelling }
})

// 清除停止标记（前端重新发起同一会话的请求前调用，避免上一次停止状态残留）
chatRouter.post('/stop/clear', async (ctx) => {
  const { sessionId } = (ctx.request.body as any) || {}
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { error: 'sessionId is required' }
    return
  }
  clearStop(String(sessionId))
  ctx.body = { ok: true, cleared: true, stopped: isStopRequested(String(sessionId)) }
})

// 暂停正在运行的 Agent（阶段二-②，2026-09-18）
// 与 /stop 的区别：停止是终态（cancelled，不再继续）；暂停是**可恢复**的 ——
// 在当前轮次边界停下并保存 checkpoint，状态落 paused，恢复时从断点续跑。
// body: { sessionId }
chatRouter.post('/pause', async (ctx) => {
  const { sessionId } = (ctx.request.body as any) || {}
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { error: 'sessionId is required' }
    return
  }
  // 只打标记不改状态：循环可能还在跑，此时状态仍 running + 带暂停标记，UI 显示"正在暂停…"
  let pausing = false
  let taskId = ''
  try {
    const t = getTaskBySession(String(sessionId))
    if (t) {
      taskId = t.task_id
      pausing = requestTaskPause(t.task_id)
    }
  } catch { /* 不影响暂停主流程 */ }
  ctx.status = pausing ? 200 : 409
  ctx.body = {
    ok: pausing,
    pausing,
    sessionId: String(sessionId),
    taskId,
    message: pausing
      ? '已请求暂停，将在当前轮次结束时停下并保存进度'
      : '没有可暂停的任务（任务不存在、已结束，或已请求取消）',
  }
})

// 恢复已暂停的任务（阶段二-②）
// 只把状态从 paused 改回 running 并回传 checkpointId；真正的续跑由前端既有通道触发
// （resumeFromCheckpoint → POST /api/chat/agent 带 checkpointId），不另造执行入口。
chatRouter.post('/resume', async (ctx) => {
  const { sessionId } = (ctx.request.body as any) || {}
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { error: 'sessionId is required' }
    return
  }
  let ok = false
  let checkpointId = ''
  let taskId = ''
  try {
    const t = getTaskBySession(String(sessionId))
    if (t) {
      taskId = t.task_id
      checkpointId = t.checkpoint_id || ''
      ok = resumeTask(t.task_id)
    }
  } catch { /* 不影响主流程 */ }
  ctx.status = ok ? 200 : 409
  ctx.body = {
    ok,
    sessionId: String(sessionId),
    taskId,
    checkpointId,
    message: ok ? '已恢复，正在从断点继续' : '任务不是暂停态，或已被取消',
  }
})
// AskQuestion 答复（Agent 提问面板的选项/输入提交）
chatRouter.post('/question-answer', async (ctx) => {
  const { questionId, answer } = (ctx.request.body as any) || {}
  if (!questionId || answer === undefined) {
    ctx.status = 400; ctx.body = { error: 'questionId and answer required' }; return
  }
  resolveQuestion(questionId, String(answer))
  ctx.body = { ok: true }
})
chatRouter.post('/tool-confirm', async (ctx) => {
  const { toolCallId, decision, sessionId, toolName } = (ctx.request.body as any) || {}
  if (!toolCallId || !['allow', 'deny', 'allow-session'].includes(decision)) {
    ctx.status = 400; ctx.body = { error: 'toolCallId and decision(allow|deny|allow-session) required' }; return
  }
  // allow-session：本会话内该工具类别放行（按工具名记忆——对齐主流实现 Always Allow 按工具类别；file_delete 仍每次确认）
  if (decision === 'allow-session') {
    if (sessionId) approveSessionTools(sessionId, toolName)
    resolveToolConfirmation(toolCallId, 'allow')
  } else {
    resolveToolConfirmation(toolCallId, decision)
  }
  ctx.body = { ok: true }
})
