/**
 * 统一任务状态 API（P0-03）
 *
 * 所有前端进度、通知、历史恢复、自动化触发都应从这里派生，
 * 而不是各自维护一份状态。
 */
import Router from 'koa-router'
import {
  listTasks,
  listActiveTasks,
  getTask,
  getTaskBySession,
  requestTaskCancel,
  requestTaskPause,
  resumeTask,
  setTaskStatus,
  statusLabel,
  aggregateTaskStats,
  type TaskStatus,
} from '../services/task-state'

export const taskStateRouter = new Router({ prefix: '/api/task-state' })

/** 列表：默认只返回活跃任务；?all=1 返回历史；?session_id= 按会话查 */
taskStateRouter.get('/', (ctx) => {
  const all = String(ctx.query.all || '') === '1'
  const sessionId = String(ctx.query.session_id || '')
  const withLabels = (rs: any[]) => rs.map((r) => ({ ...r, status_label: statusLabel(r.status) }))

  if (sessionId) {
    const t = getTaskBySession(sessionId)
    ctx.body = { ok: true, tasks: t ? withLabels([t]) : [] }
    return
  }
  ctx.body = { ok: true, tasks: withLabels(all ? listTasks() : listActiveTasks()) }
})

/**
 * 任务级可观测（P2-02）：完成率 / 失败率 / 累计 token / 累计成本 / 平均耗时。
 * 注意：必须注册在 /:id 之前，否则 'stats' 会被当成 task_id 匹配掉。
 */
taskStateRouter.get('/stats', (ctx) => {
  const days = Number(ctx.query.days || 0)
  ctx.body = { ok: true, stats: aggregateTaskStats(), days }
})

/** 单个任务 */
taskStateRouter.get('/:id', (ctx) => {
  const t = getTask(ctx.params.id)
  if (!t) {
    ctx.status = 404
    ctx.body = { ok: false, error: 'task not found' }
    return
  }
  ctx.body = { ok: true, task: { ...t, status_label: statusLabel(t.status) } }
})

/** 请求取消：只打标记，真正收敛由 agent loop 观察后完成 */
taskStateRouter.post('/:id/cancel', (ctx) => {
  const ok = requestTaskCancel(ctx.params.id)
  const t = getTask(ctx.params.id)
  ctx.status = ok ? 200 : 409
  ctx.body = { ok, task: t, message: ok ? '已请求取消' : '任务不存在或已结束' }
})

/**
 * 请求暂停（阶段二-②）：与取消同款"只打标记"语义 ——
 * 立即返回 paused=false，UI 应显示"正在暂停…"；agent loop 在轮次边界落 paused 后广播。
 */
taskStateRouter.post('/:id/pause', (ctx) => {
  const ok = requestTaskPause(ctx.params.id)
  const t = getTask(ctx.params.id)
  ctx.status = ok ? 200 : 409
  ctx.body = {
    ok,
    task: t,
    pausing: ok,
    message: ok ? '已请求暂停（将在当前轮次结束时停下）' : '任务不存在、已结束、或已请求取消',
  }
})

/**
 * 恢复（阶段二-②）：paused → running。
 * 只改状态；真正的续跑由前端既有 checkpoint 通道触发（resumeFromCheckpoint）。
 */
taskStateRouter.post('/:id/resume', (ctx) => {
  const ok = resumeTask(ctx.params.id)
  const t = getTask(ctx.params.id)
  ctx.status = ok ? 200 : 409
  ctx.body = {
    ok,
    task: t,
    message: ok ? '已恢复执行' : '任务不是暂停态，或已被取消',
    /** 前端据此走 resumeFromCheckpoint */
    checkpointId: t?.checkpoint_id || '',
  }
})

/** 手工流转（供适配器/恢复使用） */
taskStateRouter.post('/:id/status', (ctx) => {
  const body = (ctx.request.body || {}) as { status?: string; step?: string; force?: boolean }
  const to = String(body.status || '') as TaskStatus
  const ok = setTaskStatus(ctx.params.id, to, { step: body.step, force: body.force !== false })
  ctx.status = ok ? 200 : 400
  ctx.body = { ok, task: getTask(ctx.params.id) }
})
