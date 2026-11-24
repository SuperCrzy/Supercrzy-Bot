import Router from 'koa-router'
import { getDB } from '../services/database'
import { cancelStoppedGoal, completeStoppedGoal, createPersistentGoal, getOpenPersistentGoal, listGoalEvents } from '../services/persistent-goals'
import { createGoalRuntime } from '../services/goal-runtime'
import { handleAgentChat } from '../services/chat'
import { getPendingConfirmationMeta, hasPendingQuestion, requestStop } from '../services/agent'
import { isSignedIn, readSession } from '../services/account-store'
import type { GoalCoordinator } from '../services/goal-coordinator'
import type Database from 'better-sqlite3'

export const persistentGoalsRouter = new Router({ prefix: '/api/sessions/:sessionId/goal' })
const runtimes = new WeakMap<Database.Database, GoalCoordinator>()
function getRuntime(db: Database.Database): GoalCoordinator {
  let runtime = runtimes.get(db)
  if (!runtime) {
    runtime = createGoalRuntime(db, { handler: handleAgentChat, requestStop, currentAccount: () => isSignedIn() ? readSession()?.accountId || null : null })
    runtimes.set(db, runtime)
  }
  return runtime
}

persistentGoalsRouter.get('/', ctx => {
  const db = getDB()
  if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(ctx.params.sessionId)) {
    ctx.status = 404; ctx.body = { error: 'session_not_found' }; return
  }
  const goal = getOpenPersistentGoal(db, ctx.params.sessionId)
  const run = goal?.current_run_id
    ? db.prepare('SELECT started_at FROM persistent_goal_runs WHERE id = ? AND goal_id = ? AND status = ?').get(goal.current_run_id, goal.id, 'running') as { started_at: number } | undefined
    : undefined
  ctx.set('Cache-Control', 'no-store')
  ctx.body = { goal: goal ? { ...goal, running_since: run?.started_at ?? null } : null }
})

persistentGoalsRouter.post('/', ctx => {
  const body = ctx.request.body as { objective?: unknown; acceptance?: unknown } | undefined
  if (typeof body?.objective !== 'string' || (body.acceptance !== undefined && typeof body.acceptance !== 'string')) {
    ctx.status = 400; ctx.body = { error: 'invalid_goal' }; return
  }
  try {
    const goal = createPersistentGoal(getDB(), ctx.params.sessionId, body.objective, body.acceptance as string | undefined)
    ctx.status = 201; ctx.body = { goal }
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (code === 'invalid_goal') ctx.status = 400
    else if (code === 'session_not_found') ctx.status = 404
    else if (code === 'goal_already_exists') ctx.status = 409
    else throw error
    ctx.body = { error: code }
  }
})

persistentGoalsRouter.post('/:goalId/cancel', ctx => {
  const body = ctx.request.body as { version?: unknown } | undefined
  if (typeof body?.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) {
    ctx.status = 400; ctx.body = { error: 'invalid_version' }; return
  }
  const ok = cancelStoppedGoal(getDB(), ctx.params.sessionId, ctx.params.goalId, body.version)
  if (!ok) { ctx.status = 409; ctx.body = { error: 'goal_changed_or_running' }; return }
  ctx.body = { ok: true }
})

persistentGoalsRouter.get('/history', ctx => {
  const goals = getDB().prepare(`SELECT id, objective, status, last_result, elapsed_ms, updated_at FROM persistent_goals
    WHERE session_id = ? AND status IN ('completed', 'cancelled') ORDER BY updated_at DESC LIMIT 20`).all(ctx.params.sessionId)
  ctx.set('Cache-Control', 'no-store')
  ctx.body = { goals }
})

persistentGoalsRouter.post('/:goalId/complete', ctx => {
  const body = ctx.request.body as { version?: unknown } | undefined
  if (typeof body?.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) {
    ctx.status = 400; ctx.body = { error: 'invalid_version' }; return
  }
  if (!completeStoppedGoal(getDB(), ctx.params.sessionId, ctx.params.goalId, body.version)) {
    ctx.status = 409; ctx.body = { error: 'goal_changed_or_running' }; return
  }
  ctx.body = { ok: true }
})

persistentGoalsRouter.post('/:goalId/start', ctx => {
  const body = ctx.request.body as { version?: unknown; acknowledgeInterrupted?: unknown } | undefined
  if (!isSignedIn() || !readSession()?.accountId) { ctx.status = 401; ctx.body = { error: 'not_signed_in' }; return }
  if (typeof body?.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) {
    ctx.status = 400; ctx.body = { error: 'invalid_version' }; return
  }
  const db = getDB(), goal = getOpenPersistentGoal(db, ctx.params.sessionId)
  if (!goal || goal.id !== ctx.params.goalId || goal.version !== body.version) {
    ctx.status = 409; ctx.body = { error: 'goal_changed' }; return
  }
  if (goal.status === 'interrupted' && body.acknowledgeInterrupted !== true) {
    ctx.status = 409; ctx.body = { error: 'interruption_review_required' }; return
  }
  const run = getRuntime(db).start(ctx.params.sessionId, goal.id, goal.version)
  if (!run) { ctx.status = 409; ctx.body = { error: 'goal_not_startable' }; return }
  void run.completion.catch(error => console.error('[goal] failed to settle run:', error))
  ctx.status = 202; ctx.body = { ok: true, runId: run.runId }
})

persistentGoalsRouter.post('/:goalId/pause', ctx => {
  const body = ctx.request.body as { version?: unknown } | undefined
  if (typeof body?.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) {
    ctx.status = 400; ctx.body = { error: 'invalid_version' }; return
  }
  const ok = getRuntime(getDB()).pause(ctx.params.sessionId, ctx.params.goalId, body.version)
  if (!ok) { ctx.status = 409; ctx.body = { error: 'goal_not_owned_or_changed' }; return }
  ctx.status = 202; ctx.body = { ok: true, pausing: true }
})

persistentGoalsRouter.get('/:goalId/events', ctx => {
  const raw = String(ctx.query.after ?? '0')
  if (!/^\d{1,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    ctx.status = 400; ctx.body = { error: 'invalid_cursor' }; return
  }
  ctx.body = { events: listGoalEvents(getDB(), ctx.params.sessionId, ctx.params.goalId, Number(raw)) }
})

persistentGoalsRouter.get('/:goalId/pending', ctx => {
  const db = getDB()
  const goal = getOpenPersistentGoal(db, ctx.params.sessionId)
  if (!goal || goal.id !== ctx.params.goalId) { ctx.status = 404; ctx.body = { error: 'goal_not_found' }; return }
  if (!goal.current_run_id) { ctx.body = { questions: [], confirmations: [] }; return }
  const run = db.prepare('SELECT owner_pid FROM persistent_goal_runs WHERE id = ?').get(goal.current_run_id) as { owner_pid: number | null } | undefined
  if (run?.owner_pid !== process.pid) { ctx.status = 409; ctx.body = { error: 'runner_not_local' }; return }
  const events = db.prepare("SELECT event, payload FROM persistent_goal_events WHERE run_id = ? AND event IN ('question', 'tool_call') ORDER BY sequence DESC LIMIT 100")
    .all(goal.current_run_id) as Array<{ event: string; payload: string }>
  const questions: unknown[] = [], confirmations: unknown[] = [], seen = new Set<string>()
  for (const event of events) {
    let payload: any
    try { payload = JSON.parse(event.payload) } catch { continue }
    const id = typeof payload?.id === 'string' ? payload.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (event.event === 'question' && hasPendingQuestion(id)) questions.push(payload)
    if (event.event === 'tool_call' && payload.status === 'pending' && getPendingConfirmationMeta(id)?.sessionId === ctx.params.sessionId) confirmations.push(payload)
  }
  ctx.body = { questions, confirmations }
})
