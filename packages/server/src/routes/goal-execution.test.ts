import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import request from 'supertest'

const state = vi.hoisted(() => ({ run: vi.fn(), signedIn: true }))
vi.mock('../config', () => ({ config: { db: { path: ':memory:' }, deepseek: { apiKey: '', baseUrl: 'https://example.invalid', defaultModel: 'deepseek-chat' }, workspaceDir: '' } }))
vi.mock('../services/agent', () => ({ runAgentLoop: state.run, requestStop: vi.fn() }))
vi.mock('../services/account-store', () => ({ isSignedIn: () => state.signedIn, readSession: () => ({ accountId: 'owner' }), onSessionChange: () => () => {} }))
vi.mock('../services/ai-browser', () => ({ closeBrowserForSession: vi.fn() }))
import { initDatabase, getDB } from '../services/database'
import { persistentGoalsRouter } from './persistent-goals'
import { claimGoalRun, createPersistentGoal } from '../services/persistent-goals'
const app = new Koa(); app.use(bodyParser()); app.use(persistentGoalsRouter.routes())

beforeEach(() => {
  process.env.DB_PATH = ':memory:'
  state.signedIn = true
  initDatabase()
  getDB().prepare("INSERT INTO sessions (id, title) VALUES ('s', 'test')").run()
})
afterEach(() => { getDB().close(); delete process.env.DB_PATH; vi.resetAllMocks() })

describe('goal execution API', () => {
  it('edits stopped goals with version checks, preserving progress and blocking running edits', async () => {
    const db = getDB(), goal = createPersistentGoal(db, 's', '旧目标', '旧验收')
    const path = `/api/sessions/s/goal/${goal.id}/edit`
    expect((await request(app.callback()).post(path).send({ version: goal.version, objective: '  ', acceptance: '' })).status).toBe(400)
    expect((await request(app.callback()).post(path).send({ version: goal.version, objective: ' 新目标 ', acceptance: ' 新验收 ' })).status).toBe(200)
    const updated = db.prepare('SELECT * FROM persistent_goals WHERE id = ?').get(goal.id) as any
    expect(updated).toMatchObject({ objective: '新目标', acceptance: '新验收', version: goal.version + 1 })
    expect((await request(app.callback()).post(path).send({ version: goal.version, objective: '过期', acceptance: '' })).status).toBe(409)
    const run = claimGoalRun(db, 's', goal.id, updated.version)!
    expect(run).toBeTruthy()
    expect((await request(app.callback()).post(path).send({ version: updated.version + 1, objective: '运行中', acceptance: '' })).status).toBe(409)
  })
  it('reconciles a dead owner when the goal is read after startup', async () => {
    const db = getDB(), goal = createPersistentGoal(db, 's', '恢复任务')
    const run = claimGoalRun(db, 's', goal.id, goal.version)!
    db.prepare('UPDATE persistent_goal_runs SET owner_pid = ? WHERE id = ?').run(123456789, run)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
    try {
      const response = await request(app.callback()).get('/api/sessions/s/goal')
      expect(response.status).toBe(200)
      expect(response.body.goal).toMatchObject({ status: 'interrupted', current_run_id: null })
      expect(db.prepare('SELECT status FROM persistent_goal_runs WHERE id = ?').get(run)).toEqual({ status: 'interrupted' })
    } finally { kill.mockRestore() }
  })
  it('records explicit completion only for a stopped goal and lists session history', async () => {
    const created = await request(app.callback()).post('/api/sessions/s/goal').send({ objective: '完成工作' })
    const goal = created.body.goal
    const url = `/api/sessions/s/goal/${goal.id}/complete`
    expect((await request(app.callback()).post(url).send({ version: goal.version + 1 })).status).toBe(409)
    getDB().prepare("UPDATE persistent_goals SET status = 'active', current_run_id = 'running' WHERE id = ?").run(goal.id)
    expect((await request(app.callback()).post(url).send({ version: goal.version })).status).toBe(409)
    getDB().prepare("UPDATE persistent_goals SET status = 'paused', current_run_id = NULL WHERE id = ?").run(goal.id)
    expect((await request(app.callback()).post(url).send({ version: goal.version })).status).toBe(200)
    expect((await request(app.callback()).get('/api/sessions/s/goal')).body.goal).toBeNull()
    expect((await request(app.callback()).get('/api/sessions/s/goal/history')).body.goals).toMatchObject([{ id: goal.id, status: 'completed' }])
    expect((await request(app.callback()).get('/api/sessions/another/goal/history')).body.goals).toEqual([])
    expect((await request(app.callback()).post('/api/sessions/s/goal').send({ objective: '下一个目标' })).status).toBe(201)
  })
  it('starts a real chat handler once and persists its resulting events', async () => {
    state.run.mockImplementation(async (ctx: any) => {
      ctx.res.write('event: config\ndata: {}\n\n')
      ctx.res.write('event: content\ndata: {"content":"进展"}\n\n')
      ctx.res.write('event: done\ndata: {"finished":true}\n\n')
    })
    const created = await request(app.callback()).post('/api/sessions/s/goal').send({ objective: '完成工作' })
    const goal = created.body.goal
    const start = await request(app.callback()).post(`/api/sessions/s/goal/${goal.id}/start`).send({ version: goal.version, model: 'selected-model', language: 'en' })
    expect(start.status).toBe(202)
    await vi.waitFor(() => expect(state.run).toHaveBeenCalledTimes(1))
    expect(state.run.mock.calls[0][2].model).toBe('selected-model')
    expect(state.run.mock.calls[0][6]).toBe('en')
    await vi.waitFor(() => expect(getDB().prepare('SELECT status FROM persistent_goals WHERE id = ?').get(goal.id)).toEqual({ status: 'paused' }))
    const events = await request(app.callback()).get(`/api/sessions/s/goal/${goal.id}/events`)
    expect(events.body.events.map((e: any) => e.event)).toContain('content')
  })
  it('requires sign-in and explicit review before restarting an interrupted goal', async () => {
    const created = await request(app.callback()).post('/api/sessions/s/goal').send({ objective: 'goal' })
    const goal = created.body.goal
    state.signedIn = false
    expect((await request(app.callback()).post(`/api/sessions/s/goal/${goal.id}/start`).send({ version: goal.version })).status).toBe(401)
    state.signedIn = true
    getDB().prepare("UPDATE persistent_goals SET status = 'interrupted' WHERE id = ?").run(goal.id)
    const rejected = await request(app.callback()).post(`/api/sessions/s/goal/${goal.id}/start`).send({ version: goal.version })
    expect(rejected.status).toBe(409)
    expect(rejected.body.error).toBe('interruption_review_required')
  })
})
