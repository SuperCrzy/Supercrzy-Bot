import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { registerRemoteRun, requestRemoteRunStop } from './remote-run-control'

type Db = Database.Database
type EventSink = (event: { type: string; taskId: string; sessionId: string; [key: string]: unknown }) => void

function ensureRemoteRunsTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS remote_bridge_runs (
    account_id TEXT NOT NULL, task_id TEXT NOT NULL, session_id TEXT NOT NULL,
    prompt_hash TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    owner_pid INTEGER,
    PRIMARY KEY (account_id, task_id)
  )`)
  // Check and migrate under the write lock: multiple local servers may share SQLite.
  db.transaction(() => {
    const columns = db.pragma('table_info(remote_bridge_runs)') as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'owner_pid')) db.exec('ALTER TABLE remote_bridge_runs ADD COLUMN owner_pid INTEGER')
  }).immediate()
}

/** Only ESRCH proves the owning local process no longer exists. */
function processIsDefinitelyGone(pid: number): boolean {
  try { process.kill(pid, 0); return false } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export function recoverDeadRemoteRuns(db: Db, isGone: (pid: number) => boolean = processIsDefinitelyGone): number {
  ensureRemoteRunsTable(db)
  return db.transaction(() => {
    const rows = db.prepare("SELECT DISTINCT owner_pid FROM remote_bridge_runs WHERE status = 'running' AND owner_pid IS NOT NULL AND owner_pid > 0").all() as Array<{ owner_pid: number }>
    let changed = 0
    for (const { owner_pid } of rows) {
      if (isGone(owner_pid)) {
        changed += db.prepare("UPDATE remote_bridge_runs SET status = 'interrupted' WHERE status = 'running' AND owner_pid = ?").run(owner_pid).changes
      }
    }
    return changed
  }).immediate()
}

/** Reserve a task and its user message atomically before any model/tool work. */
export function reserveRemoteTask(db: Db, input: { accountId: string; taskId: string; prompt: string; sessionId?: string }) {
  recoverDeadRemoteRuns(db)
  const hash = createHash('sha256').update(input.prompt).digest('hex')
  return db.transaction(() => {
    const prior = db.prepare('SELECT session_id, prompt_hash, status FROM remote_bridge_runs WHERE account_id = ? AND task_id = ?')
      .get(input.accountId, input.taskId) as { session_id: string; prompt_hash: string; status: string } | undefined
    if (prior) {
      if (prior.prompt_hash !== hash || (input.sessionId && prior.session_id !== input.sessionId)) throw new Error('task_id_conflict')
      return { sessionId: prior.session_id, duplicate: true, status: prior.status }
    }
    const sessionId = input.sessionId || randomUUID()
    if (input.sessionId) {
      // A remote caller may only resume sessions created by its own account.
      const owned = db.prepare('SELECT 1 FROM remote_bridge_runs WHERE account_id = ? AND session_id = ? LIMIT 1').get(input.accountId, sessionId)
      if (!owned || !db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) throw new Error('remote_session_not_found')
      const active = db.prepare("SELECT 1 FROM remote_bridge_runs WHERE session_id = ? AND status = 'running' LIMIT 1").get(sessionId)
      if (active) throw new Error('remote_session_busy')
    } else {
      db.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(sessionId, input.prompt.replace(/\s+/g, ' ').slice(0, 60) || 'Remote task')
    }
    db.prepare('INSERT INTO remote_bridge_runs (account_id, task_id, session_id, prompt_hash, status, owner_pid) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.accountId, input.taskId, sessionId, hash, 'running', process.pid)
    db.prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'user', ?)")
      .run(randomUUID(), sessionId, input.prompt)
    db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId)
    return { sessionId, duplicate: false, status: 'running' }
  })()
}

/** Signal only a currently running remote task belonging to this account. */
export function cancelRemoteTask(db: Db, accountId: string, taskId: string, stop: (sessionId: string) => unknown): boolean {
  const row = db.prepare("SELECT session_id FROM remote_bridge_runs WHERE account_id = ? AND task_id = ? AND status = 'running'")
    .get(accountId, taskId) as { session_id: string } | undefined
  if (!row) return false
  // SQLite can be shared by multiple server processes, but cancellation is
  // in-process. A persisted running row alone cannot prove we can stop it.
  if (!requestRemoteRunStop(accountId, taskId)) return false
  stop(row.session_id)
  return true
}

/** Convert stored legacy content blocks to plain model input. */
function messageText(content: string): string {
  if (!content.trimStart().startsWith('[')) return content
  try {
    const blocks = JSON.parse(content)
    return Array.isArray(blocks) ? blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join('\n') : content
  } catch { return content }
}

export async function runRemoteTask(options: {
  db: Db; accountId: string; taskId: string; prompt: string; sessionId?: string; baseUrl: string
  fetcher?: typeof fetch; onEvent: EventSink
}): Promise<{ sessionId: string; duplicate: boolean; status: string }> {
  const { db, accountId, taskId, prompt } = options
  const reservation = reserveRemoteTask(db, { accountId, taskId, prompt, sessionId: options.sessionId })
  if (reservation.duplicate) return reservation
  const { sessionId } = reservation
  const releaseRun = registerRemoteRun(accountId, taskId, sessionId)
  try {
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    try { options.onEvent({ type, taskId, sessionId, ...data }) } catch { /* a disconnected observer must not discard task state */ }
  }
  const rows = db.prepare("SELECT role, content FROM messages WHERE session_id = ? AND role IN ('user','assistant') ORDER BY created_at DESC, rowid DESC LIMIT 40")
    .all(sessionId) as Array<{ role: string; content: string }>
  const messages = rows.reverse().map((row) => ({ role: row.role, content: messageText(row.content) }))
  let content = ''
  let finalContent = ''
  let completed = false
  let failed = false
  let dispatched = false
  let failure = ''
  let finalState: 'completed' | 'failed' | 'cancelled' | 'paused' | 'interrupted' | undefined
  emit('started')
  try {
    dispatched = true
    const response = await (options.fetcher || fetch)(`${options.baseUrl.replace(/\/+$/, '')}/api/chat/agent`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, sessionId }),
    })
    if (!response.ok || !response.body) {
      failed = true
      throw new Error(`chat endpoint ${response.status}`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventName = ''
    let dataLines: string[] = []
    const dispatchEvent = () => {
      if (!dataLines.length) { eventName = ''; return }
      const name = eventName || 'message'
      const rawData = dataLines.join('\n')
      eventName = ''
      dataLines = []
      let data: Record<string, unknown>
      try { data = JSON.parse(rawData) } catch { return }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return
      if (name === 'content_chunk' && typeof data.text === 'string') content += data.text
      if (name === 'content' && typeof data.content === 'string') finalContent = data.content
      // The Agent also emits recoverable warnings as `error`. The final task
      // state and checkpoint events, not an isolated warning, decide outcome.
      if (name === 'error' && typeof data.message === 'string') failure = data.message
      if (name === 'checkpoint_available' || name === 'turn_limit_reached') finalState = 'interrupted'
      if (name === 'task_state' && ['completed', 'failed', 'cancelled', 'paused'].includes(String(data.status))) {
        finalState = data.status as typeof finalState
      }
      if (name === 'done') completed = data.finished !== false
      emit('sse', { event: name, payload: data })
    }
    const consumeLine = (line: string) => {
      if (!line) { dispatchEvent(); return }
      if (line.startsWith(':')) return
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') eventName = value
      if (field === 'data') dataLines.push(value)
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) consumeLine(line.replace(/\r$/, ''))
    }
    // EOF does not terminate an SSE event. An incomplete terminal event must
    // not turn an interrupted run into a claimed success.
  } catch (error) {
    // A broken transport after dispatch does not prove the agent failed:
    // tools may already have changed external state. Never suggest a retry is safe.
    if (!dispatched) failed = true
    failure = error instanceof Error ? error.message : String(error)
  }
  const status = failed ? 'failed' : finalState || (completed ? 'completed' : 'interrupted')
  const answer = finalContent || content || (failed ? `任务执行失败：${failure}` : '')
  db.transaction(() => {
    if (answer) db.prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'assistant', ?)")
      .run(randomUUID(), sessionId, answer)
    db.prepare('UPDATE remote_bridge_runs SET status = ? WHERE account_id = ? AND task_id = ?').run(status, accountId, taskId)
    db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(sessionId)
  })()
  emit(status, failure ? { message: failure } : {})
  return { sessionId, duplicate: false, status }
  } finally {
    releaseRun()
  }
}
