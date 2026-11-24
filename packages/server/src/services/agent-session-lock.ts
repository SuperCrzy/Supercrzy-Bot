import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

/** Shared SQLite lock; only an owner known to be dead may be replaced. */
export function acquireAgentSession(db: Database.Database, sessionId: string, isGone: (pid: number) => boolean = definitelyGone): (() => void) | undefined {
  const token = randomUUID()
  const acquired = db.transaction(() => {
    const old = db.prepare('SELECT owner_pid FROM agent_session_locks WHERE session_id = ?').get(sessionId) as { owner_pid: number } | undefined
    if (old) {
      let gone = false
      try { gone = old.owner_pid > 0 && isGone(old.owner_pid) } catch { /* unknown means busy */ }
      if (!gone) return false
      db.prepare('DELETE FROM agent_session_locks WHERE session_id = ? AND owner_pid = ?').run(sessionId, old.owner_pid)
    }
    db.prepare('INSERT INTO agent_session_locks (session_id, owner_pid, token) VALUES (?, ?, ?)').run(sessionId, process.pid, token)
    return true
  }).immediate()
  if (!acquired) return undefined
  let released = false
  return () => {
    if (released) return
    db.prepare('DELETE FROM agent_session_locks WHERE session_id = ? AND token = ?').run(sessionId, token)
    released = true
  }
}

function definitelyGone(pid: number): boolean {
  try { process.kill(pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}
