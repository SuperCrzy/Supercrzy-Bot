import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { cancelRemoteTask, recoverDeadRemoteRuns, reserveRemoteTask, runRemoteTask } from './remote-task-bridge'
import { requestAllRemoteRunsStop } from './remote-run-control'
import { clearStop, isStopRequested } from './agent'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));`)
})
afterEach(() => db.close())

describe('remote task bridge', () => {
  it('persists the user and final assistant message and never replays a duplicate task', async () => {
    const fetcher = vi.fn(async () => new Response('event: content_chunk\ndata: {"text":"draft"}\n\nevent: content\ndata: {"content":"final answer"}\n\nevent: done\ndata: {"finished":true}\n\n'))
    const events: Array<{ type: string; taskId: string; sessionId: string }> = []
    const options = { db, accountId: 'account-a', taskId: 'task-1', prompt: 'hello', baseUrl: 'http://127.0.0.1:3000', fetcher, onEvent: (event: { type: string; taskId: string; sessionId: string }) => events.push(event) }
    const result = await runRemoteTask(options)
    expect(result.status).toBe('completed')
    expect(db.prepare('SELECT role, content FROM messages ORDER BY rowid').all()).toEqual([
      { role: 'user', content: 'hello' }, { role: 'assistant', content: 'final answer' },
    ])
    expect(events.map((event) => event.type)).toContain('completed')
    expect(await runRemoteTask(options)).toMatchObject({ duplicate: true, sessionId: result.sessionId })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(() => reserveRemoteTask(db, { accountId: 'account-a', taskId: 'task-1', prompt: 'different' })).toThrow('task_id_conflict')
  })

  it('keeps task reservations after interruption instead of silently repeating side effects', async () => {
    const fetcher = vi.fn(async () => new Response('event: content_chunk\ndata: {"text":"partial"}\n\n'))
    const options = { db, accountId: 'account-a', taskId: 'task-2', prompt: 'work', baseUrl: 'http://127.0.0.1:3000', fetcher, onEvent: () => {} }
    expect((await runRemoteTask(options)).status).toBe('interrupted')
    expect((await runRemoteTask(options)).duplicate).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(db.prepare("SELECT content FROM messages WHERE role='assistant'").get()).toEqual({ content: 'partial' })
  })

  it('recovers only runs whose owning process is confirmed gone and keeps task IDs reserved', () => {
    const dead = reserveRemoteTask(db, { accountId: 'account-a', taskId: 'dead-run', prompt: 'first' })
    reserveRemoteTask(db, { accountId: 'account-a', taskId: 'live-run', prompt: 'second' })
    reserveRemoteTask(db, { accountId: 'account-a', taskId: 'legacy-run', prompt: 'third' })
    db.prepare("UPDATE remote_bridge_runs SET owner_pid = 1001 WHERE task_id = 'dead-run'").run()
    db.prepare("UPDATE remote_bridge_runs SET owner_pid = 1002 WHERE task_id = 'live-run'").run()
    db.prepare("UPDATE remote_bridge_runs SET owner_pid = NULL WHERE task_id = 'legacy-run'").run()
    expect(recoverDeadRemoteRuns(db, (pid) => pid === 1001)).toBe(1)
    expect(db.prepare('SELECT task_id, status FROM remote_bridge_runs ORDER BY task_id').all()).toEqual([
      { task_id: 'dead-run', status: 'interrupted' }, { task_id: 'legacy-run', status: 'running' }, { task_id: 'live-run', status: 'running' },
    ])
    expect(reserveRemoteTask(db, { accountId: 'account-a', taskId: 'dead-run', prompt: 'first' })).toMatchObject({ duplicate: true, sessionId: dead.sessionId, status: 'interrupted' })
    expect(reserveRemoteTask(db, { accountId: 'account-a', taskId: 'new-run', prompt: 'continue', sessionId: dead.sessionId }).duplicate).toBe(false)
  })

  it('migrates old reservations without guessing their owner', () => {
    db.exec(`CREATE TABLE remote_bridge_runs (account_id TEXT NOT NULL, task_id TEXT NOT NULL, session_id TEXT NOT NULL, prompt_hash TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (account_id, task_id));
      INSERT INTO remote_bridge_runs (account_id, task_id, session_id, prompt_hash, status) VALUES ('a', 'old', 's', 'hash', 'running');`)
    expect(recoverDeadRemoteRuns(db, () => true)).toBe(0)
    expect(db.prepare("SELECT status, owner_pid FROM remote_bridge_runs WHERE task_id = 'old'").get()).toEqual({ status: 'running', owner_pid: null })
  })

  it('recognizes an actually exited local process without marking the current process interrupted', () => {
    const exited = spawnSync(process.execPath, ['-e', ''])
    expect(exited.status).toBe(0)
    expect(exited.pid).toBeGreaterThan(0)
    reserveRemoteTask(db, { accountId: 'account-a', taskId: 'exited', prompt: 'first' })
    reserveRemoteTask(db, { accountId: 'account-a', taskId: 'current', prompt: 'second' })
    db.prepare("UPDATE remote_bridge_runs SET owner_pid = ? WHERE task_id = 'exited'").run(exited.pid)
    expect(recoverDeadRemoteRuns(db)).toBe(1)
    expect(db.prepare('SELECT task_id, status FROM remote_bridge_runs ORDER BY task_id').all()).toEqual([
      { task_id: 'current', status: 'running' }, { task_id: 'exited', status: 'interrupted' },
    ])
  })

  it('treats a lost response after dispatch as an unknown interruption and never replays it', async () => {
    const fetcher = vi.fn(async () => { throw new Error('connection lost') })
    const options = { db, accountId: 'account-a', taskId: 'lost-response', prompt: 'do work', baseUrl: 'http://127.0.0.1:3000', fetcher, onEvent: () => {} }
    expect((await runRemoteTask(options)).status).toBe('interrupted')
    expect(await runRemoteTask(options)).toMatchObject({ duplicate: true, status: 'interrupted' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('only permits continuing a session owned by the same remote account', async () => {
    const first = reserveRemoteTask(db, { accountId: 'account-a', taskId: 'task-3', prompt: 'first' })
    expect(() => reserveRemoteTask(db, { accountId: 'account-b', taskId: 'task-4', prompt: 'other', sessionId: first.sessionId })).toThrow('remote_session_not_found')
    expect(() => reserveRemoteTask(db, { accountId: 'account-a', taskId: 'busy', prompt: 'continue', sessionId: first.sessionId })).toThrow('remote_session_busy')
    db.prepare("UPDATE remote_bridge_runs SET status = 'completed' WHERE task_id = 'task-3'").run()
    expect(reserveRemoteTask(db, { accountId: 'account-a', taskId: 'task-5', prompt: 'continue', sessionId: first.sessionId }).sessionId).toBe(first.sessionId)
  })

  it('only accepts cancellation for a task active in this process and owned by the caller', async () => {
    let finish!: (response: Response) => void
    let sessionId = ''
    const pending = runRemoteTask({ db, accountId: 'account-a', taskId: 'task-cancel', prompt: 'work', baseUrl: 'http://localhost', fetcher: vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })), onEvent: (event) => { if (event.type === 'started') sessionId = event.sessionId } })
    const stop = vi.fn()
    expect(cancelRemoteTask(db, 'account-b', 'task-cancel', stop)).toBe(false)
    expect(stop).not.toHaveBeenCalled()
    expect(cancelRemoteTask(db, 'account-a', 'task-cancel', stop)).toBe(true)
    expect(stop).toHaveBeenCalledWith(sessionId)
    finish(new Response('event: task_state\ndata: {"status":"cancelled"}\n\nevent: done\ndata: {"finished":true}\n\n'))
    await pending
    expect(cancelRemoteTask(db, 'account-a', 'task-cancel', stop)).toBe(false)
  })

  it('does not report cancellation accepted for a persisted run owned by another process', () => {
    reserveRemoteTask(db, { accountId: 'account-a', taskId: 'other-process', prompt: 'work' })
    db.prepare("UPDATE remote_bridge_runs SET owner_pid = ? WHERE task_id = 'other-process'").run(123456)
    const stop = vi.fn()
    expect(cancelRemoteTask(db, 'account-a', 'other-process', stop)).toBe(false)
    expect(stop).not.toHaveBeenCalled()
  })

  it('keeps account-switch cancellation set throughout initialization until the task finishes', async () => {
    let finish!: (response: Response) => void
    let startedSession = ''
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve }))
    const pending = runRemoteTask({ db, accountId: 'account-a', taskId: 'switch', prompt: 'work', baseUrl: 'http://localhost', fetcher, onEvent: (event) => { if (event.type === 'started') startedSession = event.sessionId } })
    expect(startedSession).toBeTruthy()
    requestAllRemoteRunsStop()
    clearStop(startedSession)
    expect(isStopRequested(startedSession)).toBe(true)
    finish(new Response('event: task_state\ndata: {"status":"cancelled"}\n\nevent: done\ndata: {"finished":true}\n\n'))
    expect((await pending).status).toBe('cancelled')
    expect(isStopRequested(startedSession)).toBe(false)
  })

  it('uses final task state instead of treating recoverable error events as fatal', async () => {
    const fetcher = vi.fn(async () => new Response('event: error\ndata: {"message":"retrying","retrying":true}\n\nevent: content\ndata: {"content":"done"}\n\nevent: task_state\ndata: {"status":"completed"}\n\nevent: done\ndata: {"finished":true}\n\n'))
    const result = await runRemoteTask({ db, accountId: 'account-a', taskId: 'warning', prompt: 'work', baseUrl: 'http://localhost', fetcher, onEvent: () => {} })
    expect(result.status).toBe('completed')
  })

  it('preserves cancelled task state instead of reporting done as success', async () => {
    const fetcher = vi.fn(async () => new Response('event: error\ndata: {"message":"stopping","stopped":true}\n\nevent: checkpoint_available\ndata: {}\n\nevent: task_state\ndata: {"status":"cancelled"}\n\nevent: done\ndata: {"finished":true}\n\n'))
    const result = await runRemoteTask({ db, accountId: 'account-a', taskId: 'cancelled', prompt: 'work', baseUrl: 'http://localhost', fetcher, onEvent: () => {} })
    expect(result.status).toBe('cancelled')
  })

  it('posts the saved session and history to an actual local HTTP agent', async () => {
    let requestBody: Record<string, unknown> | undefined
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        requestBody = JSON.parse(body)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: content\ndata: {"content":"local result"}\n\n')
        res.end('event: done\ndata: {"finished":true}\n\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as { port: number }).port
      const result = await runRemoteTask({ db, accountId: 'account-a', taskId: 'http-task', prompt: 'hello', baseUrl: `http://127.0.0.1:${port}`, onEvent: () => {} })
      expect(result.status).toBe('completed')
      expect(requestBody).toMatchObject({ sessionId: result.sessionId, messages: [{ role: 'user', content: 'hello' }] })
      expect(db.prepare("SELECT content FROM messages WHERE role='assistant'").get()).toEqual({ content: 'local result' })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
