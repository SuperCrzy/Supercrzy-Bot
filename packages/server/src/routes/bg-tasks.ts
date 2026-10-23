/**
 * Background task API (P0) — the server side of the "N 个后台任务运行中" bar.
 *
 * Read-only except cancel: starting a task goes through the agent tool path
 * (`shell_exec` + `run_in_background`), so approvals and the danger blacklist cannot be bypassed
 * by calling HTTP directly.
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { listBgTasks, readBgTaskOutput, cancelBgTask, deleteBgTask, getBgTask, onBgTaskDone } from '../services/bg-task'
import { safeWriteSse, registerSseStream, endSseStream } from '../services/sse-health'

export const bgTasksRouter = new Router({ prefix: '/api/bg-tasks' })

/** List tasks (newest first). `?sessionId=` narrows to one conversation. */
bgTasksRouter.get('/', (ctx: Context) => {
  const sessionId = String((ctx.query as any)?.sessionId || '')
  ctx.set('Cache-Control', 'no-store')
  ctx.body = { tasks: listBgTasks(sessionId) }
})

/**
 * Task event stream (SSE): emits `bg_task` whenever a task reaches a terminal status.
 *
 * Why SSE instead of the 2s poll: a finished task is exactly the moment the user wants to know,
 * and polling also wakes up for nothing most of the time. The client still fetches the initial list
 * once (this stream carries events only).
 */
bgTasksRouter.get('/stream', (ctx: Context) => {
  // 与项目里其它 SSE 同一个写法：respond=false + 自己 writeHead（Koa 设 body 会立即收尾）
  ctx.status = 200
  ctx.respond = false
  const res = ctx.res
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const sock = (res as any).socket
  if (sock) { sock.setNoDelay(true); sock.setTimeout(0) }
  registerSseStream(ctx, 'bg-tasks')

  safeWriteSse(ctx, `event: ready\ndata: {}\n\n`)
  const off = onBgTaskDone((task) => {
    safeWriteSse(ctx, `event: bg_task\ndata: ${JSON.stringify(task)}\n\n`)
  })
  // 心跳：中间代理/浏览器会掐掉长时间无数据的连接
  const ka = setInterval(() => safeWriteSse(ctx, `: ping\n\n`), 15_000)
  const close = () => {
    off()
    clearInterval(ka)
    endSseStream(ctx)
  }
  ctx.req.on('close', close)
  ctx.req.on('aborted', close)
})

/** One task's metadata (no output body — use /output for that). */
bgTasksRouter.get('/:id', (ctx: Context) => {
  const t = getBgTask(ctx.params.id)
  if (!t) {
    ctx.status = 404
    ctx.body = { error: '任务不存在' }
    return
  }
  ctx.body = {
    id: t.id,
    sessionId: t.sessionId,
    title: t.title,
    command: t.command,
    status: t.status,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    exitCode: t.exitCode,
    bytes: t.bytes,
  }
})

/** Incremental output: `?from=` is the `next` value returned by the previous call. */
bgTasksRouter.get('/:id/output', (ctx: Context) => {
  const from = Number((ctx.query as any)?.from || 0)
  const r = readBgTaskOutput(ctx.params.id, from)
  ctx.set('Cache-Control', 'no-store')
  if (!r.ok) {
    ctx.status = 404
    ctx.body = { error: r.error }
    return
  }
  ctx.body = { text: r.text, next: r.next, truncated: r.truncated }
})

/**
 * Delete a task record. A running task is killed first — see `deleteBgTask`.
 * (The UI shows this as the row's trash button, revealed on hover.)
 */
bgTasksRouter.delete('/:id', (ctx: Context) => {
  const r = deleteBgTask(ctx.params.id)
  if (!r.ok) {
    ctx.status = 404
    ctx.body = { error: r.error }
    return
  }
  ctx.body = { ok: true }
})

/** Cancel a running task (SIGTERM; the exit handler records `cancelled`). */
bgTasksRouter.post('/:id/cancel', (ctx: Context) => {
  const r = cancelBgTask(ctx.params.id)
  if (!r.ok) {
    ctx.status = 409
    ctx.body = { error: r.error }
    return
  }
  ctx.body = { ok: true }
})
