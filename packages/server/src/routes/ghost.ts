/**
 * Ghost Mode API — 幽灵模式建议
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { getGhostSuggestions, setGhostEnabled, isGhostEnabled, markGhostExecuted } from '../services/ghost-watch'

export const ghostRouter = new Router({ prefix: '/api/ghost' })

// 建议列表（最新在前）
ghostRouter.get('/suggestions', (ctx: Context) => {
  ctx.body = getGhostSuggestions()
})

// 开关状态
ghostRouter.get('/status', (ctx: Context) => {
  ctx.body = { enabled: isGhostEnabled(), watching: getGhostSuggestions().length > 0 || true }
})

// 开关
ghostRouter.post('/toggle', (ctx: Context) => {
  const body = ctx.request.body as { enabled?: boolean }
  if (typeof body.enabled === 'boolean') setGhostEnabled(body.enabled)
  ctx.body = { enabled: isGhostEnabled() }
})

// 标记建议已执行
ghostRouter.post('/:id/executed', (ctx: Context) => {
  markGhostExecuted(ctx.params.id)
  ctx.body = { success: true }
})

export default ghostRouter
