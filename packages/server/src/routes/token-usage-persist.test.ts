/**
 * token 用量落库口径（2026-10-22）
 *
 * 缺陷背景：模型返回的 usage 是真值，模型不返回时前端按字符×0.6 估算。
 * 两者以前都只写进 messages.token_count，落库后无法区分 ⇒ 统计把估算当真实用量汇报。
 *
 * 这里钉住三件事：
 * 1. POST /messages 的 token_estimated 必须真落库（GET 能读回）
 * 2. 同一消息幂等重写：真值到达后标记必须从 1 翻回 0（不能被旧估算卡住）
 * 3. /api/stats/usage 把估算与真值分开算，estimatedShare 随数据变化
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ---- 必须在任何服务模块加载前设置 env ----
const wsRoot = mkdtempSync(join(tmpdir(), 'supercrzy-token-ws-'))
process.env.WORKSPACE_DIR = wsRoot
process.env.DB_PATH = join(tmpdir(), `supercrzy-token-${Date.now()}.db`)

import Koa from 'koa'
import bodyParser from 'koa-bodyparser'

let app: Koa
let sessionId: string

beforeAll(async () => {
  const { initDatabase, getDB } = await import('../services/database')
  initDatabase()
  const db = getDB()
  sessionId = randomUUID()
  db.prepare("INSERT INTO sessions (id, title, model) VALUES (?, 'token 口径', 'deepseek-v4-flash')").run(sessionId)

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
  // 消息随会话一起返回（GET /api/sessions/:id → { ...session, messages }）
  const res = await request(app.callback()).get(`/api/sessions/${sessionId}`)
  expect(res.status).toBe(200)
  return res.body.messages || res.body
}

describe('messages.token_estimated 落库', () => {
  it('token_estimated=true 能读回 1', async () => {
    const id = randomUUID()
    const res = await postMessage({ id, role: 'assistant', content: '估算回复', token_count: 60, token_estimated: true })
    expect(res.status).toBe(201)

    const rows = await getMessages()
    const row = rows.find((m) => m.id === id)
    expect(row, '刚写入的消息应能读回').toBeTruthy()
    expect(row.token_count).toBe(60)
    expect(row.token_estimated).toBe(1)
  })

  it('缺省/未声明的 token_estimated 落库为 0（不把真值默认标成估算）', async () => {
    const id = randomUUID()
    await postMessage({ id, role: 'assistant', content: '真值回复', token_count: 812 })
    const row = (await getMessages()).find((m) => m.id === id)
    expect(row.token_estimated).toBe(0)
  })

  it('token_estimated 传非 true 的脏值也落 0', async () => {
    const id = randomUUID()
    await postMessage({ id, role: 'assistant', content: '脏值', token_count: 10, token_estimated: 'yes' })
    const row = (await getMessages()).find((m) => m.id === id)
    expect(row.token_estimated).toBe(0)
  })

  it('🔴 幂等重写：估算改真值时标记从 1 翻回 0', async () => {
    const id = randomUUID()
    await postMessage({ id, role: 'assistant', content: '先估算', token_count: 60, token_estimated: true })
    let row = (await getMessages()).find((m) => m.id === id)
    expect(row.token_estimated).toBe(1)

    // usage 到达 → 同一 id 重写为真值
    await postMessage({ id, role: 'assistant', content: '先估算', token_count: 812, token_estimated: false })
    const rows = await getMessages()
    row = rows.filter((m) => m.id === id)
    expect(row.length, '同一 id 不应产生重复行').toBe(1)
    expect(rows.find((m) => m.id === id).token_count).toBe(812)
    expect(rows.find((m) => m.id === id).token_estimated).toBe(0)
  })

  it('🔴 反向：真值被估算重写时，标记仍以最后一次请求为准（前端顺序错会暴露）', async () => {
    const id = randomUUID()
    await postMessage({ id, role: 'assistant', content: '先真值', token_count: 812 })
    await postMessage({ id, role: 'assistant', content: '先真值', token_count: 60, token_estimated: true })
    const row = (await getMessages()).find((m) => m.id === id)
    // 服务端只如实记录调用方声明；前端由 fillEstimatedTokens 保证不覆盖 —— 这条断言防的是
    // "服务端自作聪明保留旧标记"，那会让重写后的口径对不上库里其他列
    expect(row.token_estimated).toBe(1)
    expect(row.token_count).toBe(60)
  })
})

describe('GET /api/stats/usage 区分估算与真值', () => {
  it('估算 token 计入 estimatedTokens，真值计入 measuredTokens', async () => {
    const res = await request(app.callback()).get('/api/stats/usage')
    expect(res.status).toBe(200)
    const total = res.body.total

    // 本文件先写入：估算 60 + 真值 812 + 脏值 10(真) + 之后 812(真) + 60(估算)
    expect(total.estimatedTokens).toBeGreaterThanOrEqual(120)
    expect(total.measuredTokens).toBeGreaterThanOrEqual(812)
    expect(total.tokens).toBe(total.measuredTokens + total.estimatedTokens)
  })

  it('estimatedShare ∈ (0,1)，且不等于 0/1 时不撒谎', async () => {
    const res = await request(app.callback()).get('/api/stats/usage')
    const { estimatedShare, estimatedTokens, tokens } = res.body.total
    expect(estimatedShare).toBeGreaterThan(0)
    expect(estimatedShare).toBeLessThan(1)
    expect(estimatedShare).toBeCloseTo(estimatedTokens / tokens, 2)
  })

  it('消息条数口径：estimatedMessages ≤ tokenizedMessages', async () => {
    const res = await request(app.callback()).get('/api/stats/usage')
    const { estimatedMessages, tokenizedMessages } = res.body.total
    expect(estimatedMessages).toBeGreaterThan(0)
    expect(estimatedMessages).toBeLessThanOrEqual(tokenizedMessages)
  })

  it('byModel 每行带 estimated_tokens，且不超过该行 tokens', async () => {
    const res = await request(app.callback()).get('/api/stats/usage')
    for (const row of res.body.byModel) {
      expect(row).toHaveProperty('estimated_tokens')
      expect(row.estimated_tokens).toBeLessThanOrEqual(row.tokens)
    }
  })

  it('weekly 每天带 estimated_messages 字段（不因缺列报错）', async () => {
    const res = await request(app.callback()).get('/api/stats/usage')
    for (const day of res.body.weekly) {
      expect(day).toHaveProperty('estimated_messages')
    }
  })
})
