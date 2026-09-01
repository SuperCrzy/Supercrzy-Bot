/**
 * 超级协作平台 API — 全新串行引擎（2026-09-01，替代幽灵并行）
 * 状态机：init→executing→reviewing→(senate)→delivering→done
 * 发布后用引擎自动串行推进 + 持久化，前端只轮询 getTask 即可看到各阶段进展。
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { createCollabTask, getCollabTask, listCollabTasks, stopCollabTask } from '../services/collab-engine'

export const collabRouter = new Router({ prefix: '/api/collab' })

/**
 * POST /api/collab/tasks — 发布协作任务
 * body: { goal, mode?: 'semi'|'senate', sessionId? }
 *   semi=半自动(执行→质检，你主导)；senate=全自动议院(执行→质检→议院，AI自治)
 */
collabRouter.post('/tasks', async (ctx: Context) => {
  const body = ctx.request.body as { goal?: string; mode?: string; sessionId?: string }
  const goal = String(body.goal || '').trim()
  if (!goal) { ctx.status = 400; ctx.body = { error: 'goal is required' }; return }

  const mode = body.mode === 'senate' ? 'senate' : 'semi'
  const task = await createCollabTask(goal, mode, body.sessionId)
  ctx.status = 202
  ctx.body = { taskId: task.id, status: task.state, mode }
})

// 任务列表（持久化，重启不丢）
collabRouter.get('/tasks', (ctx: Context) => {
  ctx.body = listCollabTasks().map((t) => ({
    taskId: t.id, goal: t.goal, status: t.state === 'failed' ? 'failed' : t.state,
    state: t.state, stage: t.stage, mode: t.mode, round: t.round,
    createdAt: Date.parse(t.createdAt), ghosts: [],
    summary: t.state === 'done' ? t.delivery : '',
    delivery: t.delivery, quality: t.quality, senate: t.senate, history: t.history,
    error: t.error || undefined,
  }))
})

// 单任务详情（完整：含 delivery/quality/senate/history）
collabRouter.get('/tasks/:id', (ctx: Context) => {
  const t = getCollabTask(ctx.params.id)
  if (!t) { ctx.status = 404; ctx.body = { error: 'task not found' }; return }
  ctx.body = {
    taskId: t.id, goal: t.goal, status: t.state === 'failed' ? 'failed' : t.state,
    state: t.state, stage: t.stage, mode: t.mode, round: t.round,
    createdAt: Date.parse(t.createdAt),
    summary: t.state === 'done' ? t.delivery : '',
    quality: t.quality, senate: t.senate, history: t.history,
    error: t.error || undefined,
  }
})

// 停止任务
collabRouter.post('/tasks/:id/stop', (ctx: Context) => { ctx.body = { stopped: stopCollabTask(ctx.params.id) } })

export default collabRouter
