/**
 * 逐条消息的模型归属（2026-10-22）
 *
 * 缺陷现象：实际调用 deepseek-v4-flash，用量页「模型调用详情」却写 deepseek-v4-pro，
 * 24 条消息 / 468.7K token / ¥0.511 全挂在 pro 名下。
 *
 * 根因：/api/stats/usage 的 byModel 用 `GROUP BY s.model` —— 那是**建会话那一刻**选的模型。
 * 之后在设置页换模型，sessions.model 不会改，新消息继续挂在老模型名下，永久错配。
 * 费用本身没错（agent.ts 用真实模型单价算），错的只是那一列标签。
 *
 * 这里钉住：
 * 1. POST /messages 的 model 必须真落库（GET 能读回），缺省为 NULL
 * 2. byModel 必须按逐条 model 分组；同一会话里换了模型要裂成两行
 * 3. 迁移前老消息（model 为空）回退 sessions.model，但必须被标成「归因不可靠」并计数
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ---- 必须在任何服务模块加载前设置 env ----
const wsRoot = mkdtempSync(join(tmpdir(), 'supercrzy-attrib-ws-'))
process.env.WORKSPACE_DIR = wsRoot
process.env.DB_PATH = join(tmpdir(), `supercrzy-attrib-${Date.now()}.db`)

import Koa from 'koa'
import bodyParser from 'koa-bodyparser'

let app: Koa
let sessionId: string

// 会话创建时的模型：故意和后面真正调用的模型不一样，复现线上那一幕
const SESSION_MODEL = 'deepseek-v4-pro'
const REAL_MODEL = 'deepseek-v4-flash'

beforeAll(async () => {
  const { initDatabase, getDB } = await import('../services/database')
  initDatabase()
  const db = getDB()
  sessionId = randomUUID()
  db.prepare("INSERT INTO sessions (id, title, model) VALUES (?, '归属口径', ?)").run(sessionId, SESSION_MODEL)

  const { sessionRouter } = await import('../routes/session')
  const { statsRouter } = await import('../routes/stats')
  app = new Koa()
  app.use(bodyParser())
  app.use(sessionRouter.routes()).use(sessionRouter.allowedMethods())
  app.use(statsRouter.routes()).use(statsRouter.allowedMethods())
})

afterAll(() => {
  rmSync(wsRoot, { recursive: true, force: true })
})

async function postMessage(body: Record<string, unknown>) {
  return request(app.callback()).post(`/api/sessions/${sessionId}/messages`).send(body)
}

async function getMessages(): Promise<any[]> {
  const res = await request(app.callback()).get(`/api/sessions/${sessionId}`)
  expect(res.status).toBe(200)
  return res.body.messages || res.body
}

async function getByModel(): Promise<any[]> {
  const res = await request(app.callback()).get('/api/stats/usage')
  expect(res.status).toBe(200)
  return res.body.byModel
}

describe('messages.model 落库', () => {
  it('usage 下发的 model 能读回', async () => {
    const id = randomUUID()
    const res = await postMessage({ id, role: 'assistant', content: '真实模型回复', token_count: 100, cost: 0.5, model: REAL_MODEL })
    expect(res.status).toBe(201)

    const row = (await getMessages()).find((m) => m.id === id)
    expect(row, '刚写入的消息应能读回').toBeTruthy()
    expect(row.model).toBe(REAL_MODEL)
  })

  it('缺省 model 落库为 NULL（不拿会话模型冒充）', async () => {
    const id = randomUUID()
    await postMessage({ id, role: 'assistant', content: '无归属消息', token_count: 10 })
    const row = (await getMessages()).find((m) => m.id === id)
    expect(row.model === null || row.model === '').toBe(true)
  })

  it('空白字符串不落库（避免把 "" 当成一个模型名分组）', async () => {
    const id = randomUUID()
    await postMessage({ id, role: 'assistant', content: '空白归属', token_count: 5, model: '   ' })
    const row = (await getMessages()).find((m) => m.id === id)
    expect(row.model === null || row.model === '').toBe(true)
    const models = (await getByModel()).map((r) => r.model)
    expect(models).not.toContain('   ')
  })

  it('🔴 幂等重写：同一消息的 model 以最后一次请求为准', async () => {
    const id = randomUUID()
    await postMessage({ id, role: 'assistant', content: '先流式', token_count: 60, token_estimated: true })
    let row = (await getMessages()).find((m) => m.id === id)
    expect(row.model ?? null).toBeNull()

    await postMessage({ id, role: 'assistant', content: '先流式', token_count: 812, cost: 0.1, model: REAL_MODEL })
    const rows = await getMessages()
    expect(rows.filter((m) => m.id === id).length, '同一 id 不应产生重复行').toBe(1)
    row = rows.find((m) => m.id === id)
    expect(row.model).toBe(REAL_MODEL)
  })
})

describe('GET /api/stats/usage 按逐条 model 分组', () => {
  it('🔴 同一会话里换过模型 → 必须裂成两行，而不是全挂在 sessions.model 名下', async () => {
    const rows = await getByModel()
    const models = rows.map((r) => r.model)

    // 这个断言是反向验证的核心：GROUP BY s.model 的实现下只有 'deepseek-v4-pro' 一行
    expect(models, `byModel 里应出现真实模型 ${REAL_MODEL}；实际 ${JSON.stringify(models)}`).toContain(REAL_MODEL)
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })

  it('真实模型那一行只统计它自己的消息，token/费用不串行', async () => {
    const rows = await getByModel()
    const flash = rows.find((r) => r.model === REAL_MODEL)
    expect(flash, `${REAL_MODEL} 行应存在`).toBeTruthy()
    // 本文件里带 REAL_MODEL 的消息共 2 条（第一条 + 幂等重写那条），token 100 + 812
    expect(flash.count).toBe(2)
    expect(flash.tokens).toBe(912)
    expect(flash.cost).toBeCloseTo(0.6, 6)
    expect(flash.unattributed, '这条行全是带归属的消息').toBe(0)
  })

  it('迁移前老消息回退会话模型，并被计入 unattributed', async () => {
    const rows = await getByModel()
    const legacy = rows.find((r) => r.model === SESSION_MODEL)
    expect(legacy, `${SESSION_MODEL} 行应存在（老消息回退）`).toBeTruthy()
    // 本文件无 model 的消息：'无归属消息'(10) + '空白归属'(5) + '先流式'首写(60，后被重写覆盖成 812)
    expect(legacy.unattributed).toBe(legacy.count)
    expect(legacy.unattributed).toBeGreaterThan(0)
  })

  it('total.unattributedMessages 与库里真实的老消息条数一致（不靠自身求和自证）', async () => {
    const res = await request(app.callback()).get('/api/stats/usage')
    // 独立口径：直接数库里 model 为空的 assistant 消息。
    // 上一版这里写成「各行 unattributed 求和 == total」，那个等式在分组写错时也成立（恒真断言），
    // 挡不住任何 bug —— 必须拿数据库本身当真值来源。
    const { getDB } = await import('../services/database')
    const groundTruth = (getDB()
      .prepare("SELECT COUNT(*) as n FROM messages WHERE model IS NULL OR model = ''")
      .get() as any).n
    expect(groundTruth).toBeGreaterThan(0)
    expect(res.body.total.unattributedMessages).toBe(groundTruth)
  })

  it('任何一行都不允许模型名为空（空归属必须回退，不能出现空标签行）', async () => {
    for (const row of await getByModel()) {
      expect(typeof row.model).toBe('string')
      expect(row.model.length).toBeGreaterThan(0)
    }
  })
})
