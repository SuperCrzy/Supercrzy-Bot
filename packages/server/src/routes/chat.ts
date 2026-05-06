import Router from 'koa-router'
import { handleStreamChat, handleChat, handleAgentChat } from '../services/chat'

export const chatRouter = new Router({ prefix: '/api/chat' })

chatRouter.post('/stream', handleStreamChat)
chatRouter.post('/agent', handleAgentChat)
chatRouter.post('/', handleChat)
