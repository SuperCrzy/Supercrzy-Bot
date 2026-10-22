/**
 * /api/task-state/stats 的时间窗路由行为（B4，2026-10-22）
 *
 * 原缺陷：路由把 ?days=N 原样回显，聚合函数却不接受窗口 —— 页面写着「近 7 天」，
 * 数字却是全历史。纯函数测试只能证明聚合会过滤，**证明不了路由把参数递进去了**，
 * 所以这里走真实 HTTP。
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import request from 'supertest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const wsRoot = mkdtempSync(join(tmpdir(), 'supercrzy-taskstats-ws-'))
process.env.WORKSPACE_DIR = wsRoot
process.env.DB_PATH = join(tmpdir(), `supercrzy-taskstats-${Date.now()}.db`)

import Koa from 'koa'

let app: Koa
let createTask: typeof import('../services/task-state').createTask
let getTask: typeof import('../services/task-state').getTask
let __resetTaskState: typeof import('../services/task-state').__resetTaskState

beforeAll(async () => {
  const { initDatabase } = await import('../services/database')
  initDatabase()
  const svc = await import('../services/task-state')
  createTask = svc.createTask
  getTask = svc.getTask
  __resetTaskState = svc.__resetTaskState

  const { taskStateRouter } = await import('../routes/task-state')
  app = new Koa()
  app.use(taskStateRouter.routes()).use(taskStateRouter.allowedMethods())
})

afterEach(() => {
  __resetTaskState()
})

const DAY = 24 * 60 * 60 * 1000

async function stats(qs = '') {
  const res = await request(app.callback()).get(`/api/task-state/stats${qs}`)
  expect(res.status).toBe(200)
  return res.body
}

describe('统计窗口参数真的进到聚合里', () => {
  it('无 days ⇒ windowDays=0，返回全量', async () => {
    createTask({ sessionId: 's1', status: 'running' })
    const body = await stats()
    expect(body.days).toBe(0)
    expect(body.stats.windowDays).toBe(0)
    expect(body.stats.total).toBe(1)
  })

  it('?days=7 ⇒ windowDays=7 且回显一致', async () => {
    createTask({ sessionId: 's1', status: 'running' })
    const body = await stats('?days=7')
    expect(body.stats.windowDays).toBe(7)
    expect(body.days, 'days 必须是生效值，不是入参原样回显').toBe(7)
  })

  it('🔴 非法/负数 days 归一成 0，而不是把原值回显出去', async () => {
    createTask({ sessionId: 's1', status: 'running' })
    for (const raw of ['-7', 'abc', '0']) {
      const body = await stats(`?days=${raw}`)
      expect(body.days, `days=${raw} 应归一为 0`).toBe(0)
      expect(body.stats.windowDays).toBe(0)
    }
  })

  it('响应里带 tasks 明细（含 windowDays 与单条字段）', async () => {
    const t = createTask({ sessionId: 's1', status: 'running', label: '构建' })
    const body = await stats('?days=7')
    expect(Array.isArray(body.stats.tasks)).toBe(true)
    expect(body.stats.tasks).toHaveLength(1)
    expect(body.stats.tasks[0].task_id).toBe(t.task_id)
    expect(body.stats.tasks[0].label).toBe('构建')
    expect(body.stats.tasks[0]).toHaveProperty('tokens')
    expect(body.stats.tasks[0]).toHaveProperty('updated_at')
  })

  it('?limit=1 只返回一条明细，但 total 仍是窗口内全量', async () => {
    createTask({ sessionId: 's1', status: 'running' })
    createTask({ sessionId: 's2', status: 'running' })
    const body = await stats('?limit=1')
    expect(body.stats.tasks).toHaveLength(1)
    expect(body.stats.total).toBe(2)
  })

  it('窗口把旧任务挡在外面（用 updated_at 回推 8 天验算）', async () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    const rec = getTask(t.task_id)!
    const now = rec.updated_at + 8 * DAY
    // 直接调纯函数验边界（路由用的是真实 Date.now()，无法注入）
    const svc = await import('../services/task-state')
    expect(svc.aggregateTaskStats({ days: 7, now }).total).toBe(0)
    expect(svc.aggregateTaskStats({ days: 30, now }).total).toBe(1)
  })
})
