import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../config', () => ({ config: { db: { path: ':memory:' } } }))
import { getDB, initDatabase } from './database'
import { claimGoalRun, createPersistentGoal, getOpenPersistentGoal, reconcileDeadGoalRuns, requestGoalPause, settleGoalRun } from './persistent-goals'
import { persistentGoalsRouter } from '../routes/persistent-goals'
import { GoalCoordinator, type GoalRunResult } from './goal-coordinator'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import request from 'supertest'

const app = new Koa(); app.use(bodyParser()); app.use(persistentGoalsRouter.routes())

beforeEach(() => {
  process.env.DB_PATH = ':memory:'
  initDatabase()
  getDB().prepare("INSERT INTO sessions (id, title) VALUES ('a', 'A'), ('b', 'B')").run()
})
afterEach(() => { getDB().close(); delete process.env.DB_PATH })

describe('persistent goals storage', () => {
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
