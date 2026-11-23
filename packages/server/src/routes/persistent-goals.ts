import Router from 'koa-router'
import { getDB } from '../services/database'
import { cancelStoppedGoal, createPersistentGoal, getOpenPersistentGoal, listGoalEvents } from '../services/persistent-goals'

export const persistentGoalsRouter = new Router({ prefix: '/api/sessions/:sessionId/goal' })

persistentGoalsRouter.get('/', ctx => {
  const db = getDB()
  if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(ctx.params.sessionId)) {
    ctx.status = 404; ctx.body = { error: 'session_not_found' }; return
  }
  ctx.body = { goal: getOpenPersistentGoal(db, ctx.params.sessionId) || null }
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

persistentGoalsRouter.get('/:goalId/events', ctx => {
  const raw = String(ctx.query.after ?? '0')
  if (!/^\d{1,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    ctx.status = 400; ctx.body = { error: 'invalid_cursor' }; return
  }
  ctx.body = { events: listGoalEvents(getDB(), ctx.params.sessionId, ctx.params.goalId, Number(raw)) }
})
