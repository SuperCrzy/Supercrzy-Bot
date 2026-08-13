import Router from 'koa-router'
import { handleStreamChat, handleChat, handleAgentChat } from '../services/chat'
import { handleAgentStream } from '../services/agent-stream'
import { resolveToolConfirmation } from '../services/agent'

export const chatRouter = new Router({ prefix: '/api/chat' })

chatRouter.get('/agent', handleAgentStream)
chatRouter.post('/stream', handleStreamChat)
chatRouter.post('/agent', handleAgentChat)
chatRouter.post('/', handleChat)
chatRouter.post('/tool-confirm', async (ctx) => {
  const { toolCallId, decision } = (ctx.request.body as any) || {}
  if (!toolCallId || (decision !== 'allow' && decision !== 'deny')) {
    ctx.status = 400; ctx.body = { error: 'toolCallId and decision(allow|deny) required' }; return
  }
  resolveToolConfirmation(toolCallId, decision)
  ctx.body = { ok: true }
})
