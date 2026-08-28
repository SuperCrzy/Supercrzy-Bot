import Router from 'koa-router'
import { handleStreamChat, handleChat, handleAgentChat, handleCompareChat, handleCompareStreamChat } from '../services/chat'
import { resolveToolConfirmation, approveSessionTools, resolveQuestion } from '../services/agent'

export const chatRouter = new Router({ prefix: '/api/chat' })

chatRouter.post('/stream', handleStreamChat)
chatRouter.post('/agent', handleAgentChat)
chatRouter.post('/compare', handleCompareChat)
chatRouter.post('/compare-stream', handleCompareStreamChat)
chatRouter.post('/', handleChat)
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
  // allow-session：本会话内该工具类别放行（按工具名记忆——对齐 WorkBuddy Always Allow 按工具类别；file_delete 仍每次确认）
  if (decision === 'allow-session') {
    if (sessionId) approveSessionTools(sessionId, toolName)
    resolveToolConfirmation(toolCallId, 'allow')
  } else {
    resolveToolConfirmation(toolCallId, decision)
  }
  ctx.body = { ok: true }
})
