/**
 * Ghost Mode API — 幽灵模式建议 + 幽灵工作台（并行执行引擎）
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { randomUUID } from 'crypto'
import { getGhostSuggestions, setGhostEnabled, isGhostEnabled, markGhostExecuted } from '../services/ghost-watch'
import { runGhostTask, stopGhostTask, getGhostTask, listGhostTasks } from '../services/ghost-engine'

export const ghostRouter = new Router({ prefix: '/api/ghost' })

// ---- 幽灵工作台：并行执行引擎 ----
// 发起幽灵任务（POST /api/ghost/run { goal, workspace?, concurrency?, permissionLevel?, mode?, session_id? }）
// mode: auto=分解器判定子任务类型(默认) / research=全部子任务强制深度研究（P3 幽灵×深度研究）
// session_id: 结果回收——任务完成后注入一条汇总消息到该会话（subagent 结果回收）
ghostRouter.post('/run', async (ctx: Context) => {
  const body = ctx.request.body as { goal?: string; workspace?: string; concurrency?: number; permissionLevel?: 'workspace-only' | 'sandbox' | 'full'; mode?: 'auto' | 'research'; session_id?: string }
  if (!body.goal || !String(body.goal).trim()) {
    ctx.status = 400
    ctx.body = { error: 'goal is required' }
    return
  }
  const taskId = `gt_${Date.now()}_${randomUUID().slice(0, 6)}`
  ctx.status = 202
  ctx.body = { taskId, status: 'decomposing' }
  // 异步执行（不阻塞请求；进度通过 /ws/ghost 推送）
  runGhostTask({
    taskId,
    goal: String(body.goal).trim(),
    workspace: body.workspace || process.env.WORKSPACE_ROOT || process.cwd(),
    concurrency: body.concurrency,
    permissionLevel: body.permissionLevel,
    mode: body.mode === 'research' ? 'research' : 'auto',
    sessionId: body.session_id || undefined,
  }).catch((e: any) => console.error('[Ghost] run task failed:', e?.message))
})

// 任务列表（含运行中 + 已完成，内存态）
ghostRouter.get('/tasks', (ctx: Context) => {
  ctx.body = listGhostTasks()
})

// 单任务详情
ghostRouter.get('/tasks/:id', (ctx: Context) => {
  const t = getGhostTask(ctx.params.id)
  if (!t) { ctx.status = 404; ctx.body = { error: 'task not found' }; return }
  ctx.body = t
})

// 停止任务
ghostRouter.post('/tasks/:id/stop', (ctx: Context) => {
  ctx.body = { stopped: stopGhostTask(ctx.params.id) }
})

// ---- 观察者（原有）----
// 建议列表（最新在前）
ghostRouter.get('/suggestions', (ctx: Context) => {
  ctx.body = getGhostSuggestions()
})

// 开关状态
ghostRouter.get('/status', (ctx: Context) => {
  ctx.body = { enabled: isGhostEnabled(), watching: getGhostSuggestions().length > 0 }
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
