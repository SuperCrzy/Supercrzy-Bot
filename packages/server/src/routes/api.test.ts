/**
 * API 集成测试 — 在测试内装配 mini Koa app（临时 DB + 临时 workspace）
 * 覆盖安全关键路径：settings 脱敏/空 key 保护、workspace 穿越拦截、checkpoint 防穿越、history search
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

// ---- 必须在任何服务模块加载前设置 env（config 在模块加载时读取）----
const wsRoot = mkdtempSync(join(tmpdir(), 'supercrzy-api-ws-'))
process.env.WORKSPACE_DIR = wsRoot
process.env.DB_PATH = join(tmpdir(), `supercrzy-api-${Date.now()}.db`)

import Koa from 'koa'
import bodyParser from 'koa-bodyparser'

let app: Koa
let wsApp: Koa

beforeAll(async () => {
  // 初始化临时数据库
  const { initDatabase, getDB } = await import('../services/database')
  initDatabase()
  const db = getDB()

  // 预置 settings 数据
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('apiKey', 'sk-test-0123456789abcdef0123456789abcdef')").run()
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('qqAppSecret', 'qqsecret123456')").run()

  // 预置 history search 数据
  const sid = randomUUID()
  db.prepare("INSERT INTO sessions (id, title, model) VALUES (?, '测试会话', 'deepseek-v4-flash')").run(sid)
  db.prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'user', 'SUPERCRZY_API_TEST_UNIQUE_TOKEN 你好')").run(randomUUID(), sid)
  db.prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'assistant', '回复内容')").run(randomUUID(), sid)

  // 预置 checkpoint 文件（临时 workspace/data/checkpoints/）
  const ckptDir = join(wsRoot, 'data', 'checkpoints')
  mkdirSync(ckptDir, { recursive: true })
  const ckptId = randomUUID()
  writeFileSync(join(ckptDir, `${ckptId}.json`), JSON.stringify({
    id: ckptId, turn: 3, timestamp: new Date().toISOString(),
    messages: [{ role: 'user', content: '测试任务' }, { role: 'assistant', content: '执行中' }],
    createdFiles: [{ name: 'a.txt' }], totalToolCalls: [{ name: 'web_search' }],
  }))

  // 装配 mini app 1：settings + history
  const { settingsRouter } = await import('../routes/settings')
  const { historyRouter } = await import('../routes/history')
  app = new Koa()
  app.use(bodyParser())
  app.use(settingsRouter.routes()).use(settingsRouter.allowedMethods())
  app.use(historyRouter.routes()).use(historyRouter.allowedMethods())

  // 装配 mini app 2：workspace + checkpoints
  const { workspaceRouter } = await import('../routes/workspace')
  const { checkpointsRouter } = await import('../routes/checkpoints')
  wsApp = new Koa()
  wsApp.use(workspaceRouter.routes()).use(workspaceRouter.allowedMethods())
  wsApp.use(checkpointsRouter.routes()).use(checkpointsRouter.allowedMethods())
})

afterAll(() => {
  rmSync(wsRoot, { recursive: true, force: true })
})

describe('GET /api/settings 脱敏', () => {
  it('不返回明文 apiKey/qqAppSecret', async () => {
    const res = await request(app.callback()).get('/api/settings')
    expect(res.status).toBe(200)
    const body = res.body
    expect(body.apiKey).toBeUndefined()
    expect(body.qqAppSecret).toBeUndefined()
    expect(body.apiKeyMasked).toBe('sk-test-...cdef')
    expect(body.hasApiKey).toBe(true)
    expect(body.hasQqAppSecret).toBe(true)
  })
})

describe('POST /api/settings 空 key 保护', () => {
  it('提交空 apiKey 不覆盖已有 key', async () => {
    await request(app.callback()).post('/api/settings').send({ apiKey: '   ', model: 'deepseek-v4-flash' })
    const res = await request(app.callback()).get('/api/settings')
    expect(res.body.apiKeyMasked).toBe('sk-test-...cdef')
  })

  it('提交真实新 key 则更新', async () => {
    await request(app.callback()).post('/api/settings').send({ apiKey: 'sk-newkey1234567890abcdef' })
    const res = await request(app.callback()).get('/api/settings')
    expect(res.body.apiKeyMasked).toBe('sk-newke...cdef')
  })
})

describe('GET /api/history/search', () => {
  it('关键词命中消息', async () => {
    const res = await request(app.callback()).get('/api/history/search').query({ q: 'SUPERCRZY_API_TEST_UNIQUE_TOKEN' })
    expect(res.status).toBe(200)
    const hits = res.body.filter((m: any) => m.content.includes('SUPERCRZY_API_TEST_UNIQUE_TOKEN'))
    expect(hits.length).toBeGreaterThan(0)
  })

  it('无关键词返回空数组', async () => {
    const res = await request(app.callback()).get('/api/history/search').query({ q: '' })
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body)).toBe(true)
  })
})

describe('GET /api/workspace/files 白名单', () => {
  it('正常读取列表', async () => {
    const res = await request(wsApp.callback()).get('/api/workspace/files')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.files)).toBe(true)
    // 临时 workspace 里应有 data 目录
    expect(res.body.files.some((f: any) => f.name === 'data')).toBe(true)
  })

  it('目录穿越被拦（../ 编码）', async () => {
    const res = await request(wsApp.callback()).get('/api/workspace/files').query({ dir: '../../../../etc' })
    expect(res.status).toBe(400)
  })

  it('绝对路径逃逸被拦', async () => {
    const res = await request(wsApp.callback()).get('/api/workspace/files').query({ dir: '/etc' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/checkpoints 防穿越', () => {
  it('列表返回预置 checkpoint', async () => {
    const res = await request(wsApp.callback()).get('/api/checkpoints')
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(1)
    expect(res.body[0].turn).toBe(3)
    expect(res.body[0].fileCount).toBe(1)
  })

  it('路径穿越 ID 被拒（不读文件）', async () => {
    const res = await request(wsApp.callback()).get('/api/checkpoints/..%2F..%2Fetc%2Fpasswd')
    // 拒绝而非读文件：400/404 均可，但绝不能返回 /etc/passwd 内容
    expect([400, 404]).toContain(res.status)
    expect(res.text.includes('root:')).toBe(false)
  })

  it('合法 UUID 详情正常', async () => {
    const list = await request(wsApp.callback()).get('/api/checkpoints')
    const id = list.body[0].id
    const res = await request(wsApp.callback()).get(`/api/checkpoints/${id}`)
    expect(res.status).toBe(200)
    expect(res.body.messages.length).toBe(2)
  })
})
