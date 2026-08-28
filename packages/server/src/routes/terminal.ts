/**
 * Terminal API — 终端面板（前端可视化 terminal 六件套）
 * 供「终端面板」组件调用：列表 / 打开 / 发送 / 增量读取 / 信号 / 关闭
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { terminalOpen, terminalList, terminalSend, terminalRead, terminalSignal, terminalClose } from '../services/terminal-manager'

export const terminalRouter = new Router({ prefix: '/api/terminal' })

// 会话列表
terminalRouter.get('/', (ctx: Context) => {
  ctx.body = terminalList()
})

// 打开会话（可指定 cwd，默认工作区根）
terminalRouter.post('/', (ctx: Context) => {
  const body = (ctx.request.body as { cwd?: string }) || {}
  const r = terminalOpen(body.cwd)
  if (!r.ok) {
    ctx.status = 400
    ctx.body = { error: r.error }
    return
  }
  ctx.body = r
})

// 发送命令
terminalRouter.post('/:id/send', (ctx: Context) => {
  const body = (ctx.request.body as { command?: string }) || {}
  if (!body.command || !String(body.command).trim()) {
    ctx.status = 400
    ctx.body = { error: 'command is required' }
    return
  }
  const r = terminalSend(ctx.params.id, String(body.command))
  if (!r.ok) {
    ctx.status = 400
    ctx.body = { error: r.error }
    return
  }
  ctx.body = { ok: true }
})

// 增量读取（offset 传上次 nextOffset；消费即推进）
terminalRouter.get('/:id/read', (ctx: Context) => {
  const offset = ctx.query.offset ? Number(ctx.query.offset) : undefined
  const r = terminalRead(ctx.params.id, offset)
  if (!r.ok) {
    ctx.status = 404
    ctx.body = { error: r.error }
    return
  }
  ctx.body = r
})

// 发信号（默认 SIGINT 中断当前命令）
terminalRouter.post('/:id/signal', (ctx: Context) => {
  const body = (ctx.request.body as { signal?: string }) || {}
  const r = terminalSignal(ctx.params.id, body.signal || 'SIGINT')
  if (!r.ok) {
    ctx.status = 400
    ctx.body = { error: r.error }
    return
  }
  ctx.body = { ok: true }
})

// 关闭会话
terminalRouter.delete('/:id', (ctx: Context) => {
  ctx.body = { ok: terminalClose(ctx.params.id).ok }
})

export default terminalRouter
