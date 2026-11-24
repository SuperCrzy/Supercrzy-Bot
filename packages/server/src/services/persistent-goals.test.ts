import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../config', () => ({ config: { db: { path: ':memory:' } } }))
import { getDB, initDatabase } from './database'
import { appendGoalEvent, cancelStoppedGoal, claimGoalRun, createPersistentGoal, getOpenPersistentGoal, reconcileDeadGoalRuns, requestGoalPause, settleGoalRun } from './persistent-goals'
import { persistentGoalsRouter } from '../routes/persistent-goals'
import { GoalCoordinator, type GoalRunResult } from './goal-coordinator'
import { createGoalRuntime } from './goal-runtime'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import request from 'supertest'
import Database from 'better-sqlite3'

const app = new Koa(); app.use(bodyParser()); app.use(persistentGoalsRouter.routes())

beforeEach(() => {
  process.env.DB_PATH = ':memory:'
  initDatabase()
  getDB().prepare("INSERT INTO sessions (id, title) VALUES ('a', 'A'), ('b', 'B')").run()
})
afterEach(() => { getDB().close(); delete process.env.DB_PATH })

describe('persistent goals storage', () => {
  it('tolerates only a missing goal table, without masking other database errors', () => {
    const oldDb = new Database(':memory:')
    expect(getOpenPersistentGoal(oldDb, 'a')).toBeUndefined()
    oldDb.exec('CREATE TABLE persistent_goals (id TEXT)')
    expect(() => getOpenPersistentGoal(oldDb, 'a')).toThrow(/no such column/)
    oldDb.close()
    expect(() => getOpenPersistentGoal(oldDb, 'a')).toThrow()
  })
  it('continues on new evidence, passes progress forward and stops on repeated evidence', async () => {
    const db = getDB(), goal = createPersistentGoal(db, 'a', 'goal')
    const seen: string[] = []
    const coordinator = new GoalCoordinator(db, async ({ goal: current }) => {
      seen.push(current.last_result)
      return { outcome: 'paused', summary: `round ${seen.length}`, progressFingerprint: 'a'.repeat(64) }
    })
    await coordinator.start('a', goal.id, goal.version)!.completion
    expect(seen).toEqual(['', 'round 1'])
    expect(getOpenPersistentGoal(db, 'a')).toMatchObject({ status: 'paused', last_result: 'round 2' })
  })

  it('bounds repeated continuations and stops at three turns', async () => {
    const db = getDB(), goal = createPersistentGoal(db, 'a', 'goal')
    let count = 0
    const coordinator = new GoalCoordinator(db, async () => ({ outcome: 'paused', summary: `round ${++count}`, progressFingerprint: count.toString(16).repeat(64) }))
    await coordinator.start('a', goal.id, goal.version)!.completion
    expect(count).toBe(3)
    expect(getOpenPersistentGoal(db, 'a')).toMatchObject({ status: 'paused', last_result: 'round 3' })
  })
  it('passes the session history and full goal into the normal Agent handler', async () => {
    const db = getDB(), goal = createPersistentGoal(db, 'a', '完成项目', '测试通过')
    db.prepare("INSERT INTO messages (id, session_id, role, content) VALUES ('m1', 'a', 'user', '前情')").run()
    let sent: any
    const runtime = createGoalRuntime(db, { currentAccount: () => 'account', requestStop: vi.fn(), handler: async ctx => {
      sent = ctx.request.body
      ctx.res.write('event: config\ndata: {}\n\n')
      ctx.res.write('event: content\ndata: {"content":"完成一部分"}\n\n')
      ctx.res.write('event: done\ndata: {"finished":true}\n\n')
    } })
    await runtime.start('a', goal.id, goal.version)!.completion
    expect(sent.sessionId).toBe('a')
    expect(sent.messages[0].content).toBe('前情')
    expect(sent.messages.at(-1).content).toContain('完成项目')
    expect(sent.messages.at(-1).content).toContain('测试通过')
    expect(getOpenPersistentGoal(db, 'a')).toMatchObject({ status: 'paused', last_result: '完成一部分' })
  })
  it('passes persisted recent goal progress to a later run without mixing other goals', async () => {
    const db = getDB(), goal = createPersistentGoal(db, 'a', '目标 A')
    const other = createPersistentGoal(db, 'b', '目标 B')
    const first = claimGoalRun(db, 'a', goal.id, goal.version)!
    expect(settleGoalRun(db, goal.id, first, 'paused', '第一轮已检查配置')).toBe(true)
    const second = claimGoalRun(db, 'a', goal.id, getOpenPersistentGoal(db, 'a')!.version)!
    expect(settleGoalRun(db, goal.id, second, 'paused', '第二轮已修复问题')).toBe(true)
    const otherRun = claimGoalRun(db, 'b', other.id, other.version)!
    expect(settleGoalRun(db, other.id, otherRun, 'paused', '其他会话私有结果')).toBe(true)
    let sent: any
    const runtime = createGoalRuntime(db, { currentAccount: () => 'account', requestStop: vi.fn(), handler: async ctx => {
      sent = ctx.request.body
      ctx.res.write('event: config\ndata: {}\n\n')
      ctx.res.write('event: done\ndata: {"finished":true}\n\n')
    } })
    await runtime.start('a', goal.id, getOpenPersistentGoal(db, 'a')!.version)!.completion
    const prompt = sent.messages.at(-1).content
    expect(prompt).toContain('第一轮已检查配置')
    expect(prompt).toContain('第二轮已修复问题')
    expect(prompt).not.toContain('其他会话私有结果')
  })
  it('signals a pause without claiming that the runner has stopped', async () => {
    const db = getDB(), goal = createPersistentGoal(db, 'a', 'goal')
    let finish!: (result: GoalRunResult) => void
    let signal: AbortSignal | undefined
    const coordinator = new GoalCoordinator(db, async input => { signal = input.signal; return new Promise(resolve => { finish = resolve }) })
    const run = coordinator.start('a', goal.id, goal.version)!
    await Promise.resolve()
    const active = getOpenPersistentGoal(db, 'a')!
    expect(coordinator.pause('a', goal.id, active.version)).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(getOpenPersistentGoal(db, 'a')?.status).toBe('pausing')
    finish({ outcome: 'paused', summary: 'saved' })
    await run.completion
    expect(getOpenPersistentGoal(db, 'a')).toMatchObject({ status: 'paused', last_result: 'saved' })
  })

  it('marks a runner failure interrupted, never completed', async () => {
    const db = getDB(), goal = createPersistentGoal(db, 'a', 'goal')
    const coordinator = new GoalCoordinator(db, async () => { throw new Error('connection lost') })
    await coordinator.start('a', goal.id, goal.version)!.completion
    expect(getOpenPersistentGoal(db, 'a')).toMatchObject({ status: 'interrupted', last_result: 'connection lost' })
  })

  it('persists runner events for reconnect without exposing them to another session', async () => {
    const db = getDB(), goal = createPersistentGoal(db, 'a', 'goal')
    const coordinator = new GoalCoordinator(db, async ({ emit }) => {
      emit('question', { id: 'q1', question: '请选择' })
      emit('tool_call', { id: 't1', status: 'pending' })
      return { outcome: 'waiting_user', summary: 'waiting' }
    })
    await coordinator.start('a', goal.id, goal.version)!.completion
    const response = await request(app.callback()).get(`/api/sessions/a/goal/${goal.id}/events`)
    expect(response.body.events.map((e: any) => e.event)).toEqual(['question', 'tool_call'])
    expect(response.body.events[0].payload.question).toBe('请选择')
    const after = response.body.events[0].sequence
    expect((await request(app.callback()).get(`/api/sessions/a/goal/${goal.id}/events?after=${after}`)).body.events).toHaveLength(1)
    expect((await request(app.callback()).get(`/api/sessions/b/goal/${goal.id}/events`)).body.events).toEqual([])
    expect((await request(app.callback()).get(`/api/sessions/a/goal/${goal.id}/events?after=-1`)).status).toBe(400)
  })
  it('pages a large event backlog without gaps or duplicates', async () => {
    const db = getDB(), goal = createPersistentGoal(db, 'a', 'goal')
    const run = claimGoalRun(db, 'a', goal.id, goal.version)!
    for (let i = 0; i < 205; i++) expect(appendGoalEvent(db, goal.id, run, 'content_chunk', { text: String(i) })).toBe(true)
    const all: any[] = []
    let cursor = 0
    for (let page = 0; page < 3; page++) {
      const response = await request(app.callback()).get(`/api/sessions/a/goal/${goal.id}/events?after=${cursor}`)
      expect(response.status).toBe(200)
      all.push(...response.body.events)
      cursor = all.at(-1).sequence
    }
    expect(all).toHaveLength(205)
    expect(all.map(event => event.payload.text)).toEqual(Array.from({ length: 205 }, (_, i) => String(i)))
    expect((await request(app.callback()).get(`/api/sessions/a/goal/${goal.id}/events?after=${cursor}`)).body.events).toEqual([])
  })
  it('keeps full goals per session and starts them paused', () => {
    const db = getDB()
    const goal = createPersistentGoal(db, 'a', '  完整目标  ', '  验收条件  ')
    expect(goal).toMatchObject({ objective: '完整目标', acceptance: '验收条件', status: 'paused', elapsed_ms: 0 })
    expect(getOpenPersistentGoal(db, 'a')?.id).toBe(goal.id)
    expect(getOpenPersistentGoal(db, 'b')).toBeUndefined()
  })

  it('rejects invalid, missing-session and duplicate open goals', () => {
    const db = getDB()
    expect(() => createPersistentGoal(db, 'a', '  ')).toThrow('invalid_goal')
    expect(() => createPersistentGoal(db, 'missing', 'goal')).toThrow('session_not_found')
    createPersistentGoal(db, 'a', 'first')
    expect(() => createPersistentGoal(db, 'a', 'second')).toThrow('goal_already_exists')
    expect(createPersistentGoal(db, 'b', 'other').session_id).toBe('b')
  })

  it('enforces uniqueness in the database and permits a new goal after completion', () => {
    const db = getDB()
    const first = createPersistentGoal(db, 'a', 'first')
    expect(() => db.prepare("INSERT INTO persistent_goals (id, session_id, objective, status, created_at, updated_at) VALUES ('duplicate', 'a', 'duplicate', 'paused', 1, 1)").run()).toThrow()
    db.prepare("UPDATE persistent_goals SET status = 'completed' WHERE id = ?").run(first.id)
    expect(createPersistentGoal(db, 'a', 'second').id).not.toBe(first.id)
    db.prepare("DELETE FROM sessions WHERE id = 'a'").run()
    expect(db.prepare("SELECT count(*) AS n FROM persistent_goals WHERE session_id = 'a'").get()).toEqual({ n: 0 })
  })

  it('exposes only session-scoped creation, lookup and versioned cancellation', async () => {
    const created = await request(app.callback()).post('/api/sessions/a/goal').send({ objective: '长期目标' })
    expect(created.status).toBe(201)
    const goal = created.body.goal
    expect(goal.status).toBe('paused')
    expect((await request(app.callback()).get('/api/sessions/b/goal')).body.goal).toBeNull()
    expect((await request(app.callback()).post('/api/sessions/a/goal').send({ objective: 'another' })).status).toBe(409)
    expect((await request(app.callback()).post(`/api/sessions/b/goal/${goal.id}/cancel`).send({ version: goal.version })).status).toBe(409)
    expect((await request(app.callback()).post(`/api/sessions/a/goal/${goal.id}/cancel`).send({ version: goal.version + 1 })).status).toBe(409)
    expect((await request(app.callback()).post(`/api/sessions/a/goal/${goal.id}/cancel`).send({ version: goal.version })).status).toBe(200)
    expect((await request(app.callback()).get('/api/sessions/a/goal')).body.goal).toBeNull()
  })

  it('claims one run, counts actual elapsed time and rejects stale results', () => {
    const db = getDB(), goal = createPersistentGoal(db, 'a', 'goal')
    const run = claimGoalRun(db, 'a', goal.id, goal.version, 1000)!
    expect(run).toBeTruthy()
    expect(claimGoalRun(db, 'a', goal.id, goal.version, 1001)).toBeUndefined()
    expect(settleGoalRun(db, goal.id, 'wrong-run', 'paused', 'wrong', 5000)).toBe(false)
    expect(settleGoalRun(db, goal.id, run, 'waiting_user', 'need input', 4000)).toBe(true)
    expect(settleGoalRun(db, goal.id, run, 'paused', 'duplicate', 5000)).toBe(false)
    expect(getOpenPersistentGoal(db, 'a')).toMatchObject({ status: 'waiting_user', elapsed_ms: 3000, last_result: 'need input', current_run_id: null })
  })

  it('keeps a pause request pending until the owner run settles', () => {
    const db = getDB(), goal = createPersistentGoal(db, 'a', 'goal')
    const run = claimGoalRun(db, 'a', goal.id, goal.version, 1000)!
    const active = getOpenPersistentGoal(db, 'a')!
    expect(requestGoalPause(db, 'b', goal.id, active.version)).toBeUndefined()
    expect(requestGoalPause(db, 'a', goal.id, active.version)).toBe(run)
    const pausing = getOpenPersistentGoal(db, 'a')!
    expect(pausing).toMatchObject({ status: 'pausing', current_run_id: run })
    expect(claimGoalRun(db, 'a', goal.id, pausing.version)).toBeUndefined()
    expect(settleGoalRun(db, goal.id, run, 'waiting_user', 'stopped', 2000)).toBe(true)
    expect(getOpenPersistentGoal(db, 'a')).toMatchObject({ status: 'paused', current_run_id: null, elapsed_ms: 1000 })
  })

  it('allows a settled waiting goal to resume or end but rejects stale versions', () => {
    const db = getDB(), goal = createPersistentGoal(db, 'a', 'goal')
    const firstRun = claimGoalRun(db, 'a', goal.id, goal.version)!
    expect(settleGoalRun(db, goal.id, firstRun, 'waiting_user', 'need input')).toBe(true)
    const waiting = getOpenPersistentGoal(db, 'a')!
    expect(cancelStoppedGoal(db, 'a', goal.id, waiting.version - 1)).toBe(false)
    const secondRun = claimGoalRun(db, 'a', goal.id, waiting.version)!
    expect(secondRun).toBeTruthy()
    const active = getOpenPersistentGoal(db, 'a')!
    expect(cancelStoppedGoal(db, 'a', goal.id, active.version)).toBe(false)
    expect(settleGoalRun(db, goal.id, secondRun, 'waiting_user', 'still waiting')).toBe(true)
    const waitingAgain = getOpenPersistentGoal(db, 'a')!
    expect(cancelStoppedGoal(db, 'a', goal.id, waitingAgain.version)).toBe(true)
    expect(getOpenPersistentGoal(db, 'a')).toBeUndefined()
  })

  it('marks only definitely dead owners interrupted, without guessing elapsed time', () => {
    const db = getDB(), a = createPersistentGoal(db, 'a', 'one'), b = createPersistentGoal(db, 'b', 'two')
    const deadRun = claimGoalRun(db, 'a', a.id, a.version, 1000)!
    const liveRun = claimGoalRun(db, 'b', b.id, b.version, 1000)!
    db.prepare('UPDATE persistent_goal_runs SET owner_pid = ? WHERE id = ?').run(12345, deadRun)
    db.prepare('UPDATE persistent_goal_runs SET owner_pid = ? WHERE id = ?').run(23456, liveRun)
    expect(reconcileDeadGoalRuns(db, pid => pid === 23456, 5000)).toBe(1)
    expect(getOpenPersistentGoal(db, 'a')).toMatchObject({ status: 'interrupted', elapsed_ms: 0, current_run_id: null })
    expect(getOpenPersistentGoal(db, 'b')).toMatchObject({ status: 'active', current_run_id: liveRun })
    expect(settleGoalRun(db, a.id, deadRun, 'paused', 'late', 6000)).toBe(false)
  })

  it('rolls back a claim if the run record cannot be inserted', () => {
    const db = getDB(), goal = createPersistentGoal(db, 'a', 'goal')
    db.exec("CREATE TRIGGER fail_run BEFORE INSERT ON persistent_goal_runs BEGIN SELECT RAISE(FAIL, 'failure'); END")
    expect(() => claimGoalRun(db, 'a', goal.id, goal.version)).toThrow('failure')
    expect(getOpenPersistentGoal(db, 'a')).toMatchObject({ status: 'paused', current_run_id: null, version: goal.version })
  })
})
