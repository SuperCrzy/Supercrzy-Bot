import Router from 'koa-router'
import { handleStreamChat, handleChat, handleAgentChat } from '../services/chat'
import { handleAgentStream } from '../services/agent-stream'

export const chatRouter = new Router({ prefix: '/api/chat' })

chatRouter.get('/agent', handleAgentStream)
chatRouter.post('/stream', handleStreamChat)
chatRouter.post('/agent', handleAgentChat)
chatRouter.post('/', handleChat)
