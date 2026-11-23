import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface PersistentGoal {
  id: string
  session_id: string
  objective: string
  acceptance: string
  status: 'paused' | 'active' | 'pausing' | 'waiting_user' | 'interrupted' | 'completed' | 'cancelled'
  elapsed_ms: number
  current_run_id: string | null
  last_result: string
  version: number
  created_at: number
  updated_at: number
}

/** Creates a stopped goal; execution must be started by a separate coordinator. */
export function createPersistentGoal(db: Database.Database, sessionId: string, objective: string, acceptance = ''): PersistentGoal {
  const text = typeof objective === 'string' ? objective.trim() : ''
  const criteria = typeof acceptance === 'string' ? acceptance.trim() : ''
  if (!sessionId || !text || text.length > 20_000 || criteria.length > 20_000) throw new Error('invalid_goal')
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) throw new Error('session_not_found')
    if (getOpenPersistentGoal(db, sessionId)) throw new Error('goal_already_exists')
    const id = randomUUID(), now = Date.now()
    db.prepare(`INSERT INTO persistent_goals (id, session_id, objective, acceptance, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'paused', ?, ?)`).run(id, sessionId, text, criteria, now, now)
    return db.prepare('SELECT * FROM persistent_goals WHERE id = ?').get(id) as PersistentGoal
  })()
}

export function getOpenPersistentGoal(db: Database.Database, sessionId: string): PersistentGoal | undefined {
  return db.prepare("SELECT * FROM persistent_goals WHERE session_id = ? AND status NOT IN ('completed', 'cancelled')").get(sessionId) as PersistentGoal | undefined
}

/** Only a stopped goal may be cancelled here; running goals need the coordinator. */
export function cancelStoppedGoal(db: Database.Database, sessionId: string, id: string, version: number): boolean {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('invalid_version')
  const result = db.prepare(`UPDATE persistent_goals SET status = 'cancelled', version = version + 1, updated_at = ?
    WHERE id = ? AND session_id = ? AND version = ? AND status IN ('paused', 'interrupted') AND current_run_id IS NULL`)
    .run(Date.now(), id, sessionId, version)
  return result.changes === 1
}

/** Atomically claims one execution; duplicate clicks and workers cannot both run it. */
export function claimGoalRun(db: Database.Database, sessionId: string, goalId: string, version: number, now = Date.now()): string | undefined {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('invalid_version')
  return db.transaction(() => {
    const runId = randomUUID()
    const claim = db.prepare(`UPDATE persistent_goals SET status = 'active', current_run_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND session_id = ? AND version = ? AND status IN ('paused', 'interrupted') AND current_run_id IS NULL`)
      .run(runId, now, goalId, sessionId, version)
    if (claim.changes !== 1) return undefined
    db.prepare("INSERT INTO persistent_goal_runs (id, goal_id, status, started_at) VALUES (?, ?, 'running', ?)").run(runId, goalId, now)
    return runId
  })()
}

/** Record a settled run, accepting only the run that still owns the goal. */
export function settleGoalRun(db: Database.Database, goalId: string, runId: string, outcome: 'paused' | 'waiting_user' | 'interrupted', result: string, now = Date.now()): boolean {
  return db.transaction(() => {
    const run = db.prepare("SELECT started_at FROM persistent_goal_runs WHERE id = ? AND goal_id = ? AND status = 'running'").get(runId, goalId) as { started_at: number } | undefined
    if (!run) return false
    const elapsed = Math.max(0, now - run.started_at)
    const updated = db.prepare(`UPDATE persistent_goals SET status = ?, current_run_id = NULL, elapsed_ms = elapsed_ms + ?,
      last_result = ?, version = version + 1, updated_at = ? WHERE id = ? AND current_run_id = ? AND status IN ('active', 'pausing')`)
      .run(outcome, elapsed, result, now, goalId, runId)
    if (updated.changes !== 1) return false
    db.prepare("UPDATE persistent_goal_runs SET status = ?, ended_at = ?, result = ? WHERE id = ? AND status = 'running'")
      .run(outcome === 'interrupted' ? 'interrupted' : 'finished', now, result, runId)
    return true
  })()
}
