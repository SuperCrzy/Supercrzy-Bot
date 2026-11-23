import type Database from 'better-sqlite3'

/** Keep model-declared step states; closing a stream is not proof of completion. */
export function finalizePlan(db: Database.Database, sessionId: string, runSucceeded: boolean) {
  return db.transaction(() => {
    const plan = db.prepare("SELECT id, subject FROM tasks WHERE session_id=? AND parent_id IS NULL AND status='in_progress' ORDER BY created_at DESC LIMIT 1").get(sessionId) as { id: string; subject: string } | undefined
    if (!plan) return null
    const steps = db.prepare('SELECT id, subject, status FROM tasks WHERE parent_id=? ORDER BY sort_order').all(plan.id) as Array<{ id: string; subject: string; status: string }>
    if (runSucceeded && steps.length > 0 && steps.every(step => step.status === 'completed')) {
      db.prepare("UPDATE tasks SET status='completed' WHERE id=? AND status='in_progress'").run(plan.id)
    }
    return { planId: plan.id, title: plan.subject, steps }
  })()
}
