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
  try {
    return db.prepare("SELECT * FROM persistent_goals WHERE session_id = ? AND status NOT IN ('completed', 'cancelled')").get(sessionId) as PersistentGoal | undefined
  } catch {
    // Called from the chat entry point, which must survive a database that predates
    // this table — an older install, a restored backup, or a test harness that builds
    // its own schema. A missing goals table means "no goal", not "chat is broken".
    return undefined
  }
}

/** Reject stale emitters and oversized events rather than silently losing approvals. */
export function appendGoalEvent(db: Database.Database, goalId: string, runId: string, event: string, payload: unknown): boolean {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(event)) throw new Error('invalid_event')
  const json = JSON.stringify(payload)
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > 128 * 1024) throw new Error('invalid_event_payload')
  const result = db.prepare(`INSERT INTO persistent_goal_events (goal_id, run_id, event, payload, created_at)
    SELECT id, ?, ?, ?, ? FROM persistent_goals WHERE id = ? AND current_run_id = ? AND status IN ('active', 'pausing')`)
    .run(runId, event, json, Date.now(), goalId, runId)
  return result.changes === 1
}

export function listGoalEvents(db: Database.Database, sessionId: string, goalId: string, after: number) {
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('invalid_cursor')
  const rows = db.prepare(`SELECT e.sequence, e.run_id, e.event, e.payload, e.created_at FROM persistent_goal_events e
    JOIN persistent_goals g ON g.id = e.goal_id WHERE g.session_id = ? AND g.id = ? AND e.sequence > ? ORDER BY e.sequence LIMIT 100`)
    .all(sessionId, goalId, after) as Array<{ sequence: number; run_id: string; event: string; payload: string; created_at: number }>
  return rows.map(row => ({ ...row, payload: JSON.parse(row.payload) }))
}

/** Only a stopped goal may be cancelled here; running goals need the coordinator. */
export function cancelStoppedGoal(db: Database.Database, sessionId: string, id: string, version: number): boolean {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('invalid_version')
  const result = db.prepare(`UPDATE persistent_goals SET status = 'cancelled', version = version + 1, updated_at = ?
    WHERE id = ? AND session_id = ? AND version = ? AND status IN ('paused', 'interrupted', 'waiting_user') AND current_run_id IS NULL`)
    .run(Date.now(), id, sessionId, version)
  return result.changes === 1
}

/** Completion is an explicit user decision, never inferred from an Agent turn. */
export function completeStoppedGoal(db: Database.Database, sessionId: string, id: string, version: number): boolean {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('invalid_version')
  return db.prepare(`UPDATE persistent_goals SET status = 'completed', version = version + 1, updated_at = ?
    WHERE id = ? AND session_id = ? AND version = ? AND status IN ('paused', 'interrupted', 'waiting_user') AND current_run_id IS NULL`)
    .run(Date.now(), id, sessionId, version).changes === 1
}

/** Atomically claims one execution; duplicate clicks and workers cannot both run it. */
export function claimGoalRun(db: Database.Database, sessionId: string, goalId: string, version: number, now = Date.now()): string | undefined {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('invalid_version')
  return db.transaction(() => {
    const runId = randomUUID()
    const claim = db.prepare(`UPDATE persistent_goals SET status = 'active', current_run_id = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND session_id = ? AND version = ? AND status IN ('paused', 'interrupted', 'waiting_user') AND current_run_id IS NULL`)
      .run(runId, now, goalId, sessionId, version)
    if (claim.changes !== 1) return undefined
    db.prepare("INSERT INTO persistent_goal_runs (id, goal_id, status, started_at, owner_pid) VALUES (?, ?, 'running', ?, ?)").run(runId, goalId, now, process.pid)
    return runId
  })()
}

/** Reconcile only runs whose owning local process is definitely gone. */
export function reconcileDeadGoalRuns(db: Database.Database, ownerIsAlive: (pid: number) => boolean, now = Date.now()): number {
  const runs = db.prepare("SELECT id, goal_id, owner_pid FROM persistent_goal_runs WHERE status = 'running' AND owner_pid IS NOT NULL").all() as Array<{ id: string; goal_id: string; owner_pid: number }>
  let count = 0
  for (const run of runs) {
    if (!Number.isSafeInteger(run.owner_pid) || run.owner_pid <= 0) continue
    let alive = true
    try { alive = ownerIsAlive(run.owner_pid) } catch { /* unknown is not proof of death */ }
    if (alive) continue
    db.transaction(() => {
      const updated = db.prepare(`UPDATE persistent_goals SET status = 'interrupted', current_run_id = NULL,
        last_result = '执行进程已结束，请检查进度后再恢复。', version = version + 1, updated_at = ?
        WHERE id = ? AND current_run_id = ? AND status IN ('active', 'pausing')`).run(now, run.goal_id, run.id)
      if (updated.changes !== 1) return
      db.prepare("UPDATE persistent_goal_runs SET status = 'interrupted', ended_at = ? WHERE id = ? AND status = 'running'").run(now, run.id)
      count++
    })()
  }
  return count
}

/** Mark a running goal as pausing; the caller must also signal its executor. */
export function requestGoalPause(db: Database.Database, sessionId: string, goalId: string, version: number, now = Date.now(), expectedRunId?: string): string | undefined {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('invalid_version')
  return db.transaction(() => {
    const goal = db.prepare("SELECT current_run_id FROM persistent_goals WHERE id = ? AND session_id = ? AND version = ? AND status = 'active'")
      .get(goalId, sessionId, version) as { current_run_id: string | null } | undefined
    if (!goal?.current_run_id || (expectedRunId && goal.current_run_id !== expectedRunId)) return undefined
    const changed = db.prepare("UPDATE persistent_goals SET status = 'pausing', version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'active'")
      .run(now, goalId, version)
    return changed.changes === 1 ? goal.current_run_id : undefined
  })()
}

/** Update the continuation context only while this exact run is still active. */
export function recordGoalProgress(db: Database.Database, goalId: string, runId: string, summary: string): boolean {
  const changed = db.prepare("UPDATE persistent_goals SET last_result = ?, version = version + 1, updated_at = ? WHERE id = ? AND current_run_id = ? AND status = 'active'")
    .run(summary.slice(0, 20_000), Date.now(), goalId, runId)
  return changed.changes === 1
}

/** Record a settled run, accepting only the run that still owns the goal. */
export function settleGoalRun(db: Database.Database, goalId: string, runId: string, outcome: 'paused' | 'waiting_user' | 'interrupted', result: string, now = Date.now()): boolean {
  return db.transaction(() => {
    const run = db.prepare("SELECT started_at FROM persistent_goal_runs WHERE id = ? AND goal_id = ? AND status = 'running'").get(runId, goalId) as { started_at: number } | undefined
    if (!run) return false
    const elapsed = Math.max(0, now - run.started_at)
    const updated = db.prepare(`UPDATE persistent_goals SET status = CASE WHEN status = 'pausing' AND ? != 'interrupted' THEN 'paused' ELSE ? END, current_run_id = NULL, elapsed_ms = elapsed_ms + ?,
      last_result = ?, version = version + 1, updated_at = ? WHERE id = ? AND current_run_id = ? AND status IN ('active', 'pausing')`)
      .run(outcome, outcome, elapsed, result, now, goalId, runId)
    if (updated.changes !== 1) return false
    db.prepare("UPDATE persistent_goal_runs SET status = ?, ended_at = ?, result = ? WHERE id = ? AND status = 'running'")
      .run(outcome === 'interrupted' ? 'interrupted' : 'finished', now, result, runId)
    return true
  })()
}
