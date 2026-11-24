import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import request from 'supertest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const state = vi.hoisted(() => ({ run: vi.fn(), db: null as any }))
vi.mock('./database', () => ({ getDB: () => state.db }))
vi.mock('./agent', () => ({ runAgentLoop: state.run }))
vi.mock('./ai-browser', () => ({ closeBrowserForSession: vi.fn() }))
import { handleAgentChat } from './chat'
import { acquireAgentSession } from './agent-session-lock'

const app = new Koa(); app.use(bodyParser()); app.use(handleAgentChat)
beforeEach(() => {
  state.db = new Database(':memory:')
  state.db.exec('CREATE TABLE settings (key TEXT, value TEXT); CREATE TABLE custom_models (id TEXT, model_id TEXT, enabled INTEGER, provider_id TEXT); CREATE TABLE custom_providers (id TEXT, base_url TEXT, api_key TEXT); CREATE TABLE agent_session_locks (session_id TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, token TEXT NOT NULL)')
})
afterEach(() => { state.db.close(); vi.clearAllMocks() })

describe('agent session exclusivity', () => {
  it('enforces the lock across separate database connections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-lock-'))
    const first = new Database(join(dir, 'db.sqlite')), second = new Database(join(dir, 'db.sqlite'))
    try {
      first.exec('CREATE TABLE agent_session_locks (session_id TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, token TEXT NOT NULL)')
      const release = acquireAgentSession(first, 'shared')!
      expect(acquireAgentSession(second, 'shared')).toBeUndefined()
      release()
      const secondRelease = acquireAgentSession(second, 'shared')
      expect(secondRelease).toBeTypeOf('function')
      secondRelease!()
    } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('does not steal a live lock; reclaims a definitely dead owner and prevents stale release', () => {
    const release = acquireAgentSession(state.db, 's')!
    expect(acquireAgentSession(state.db, 's', () => false)).toBeUndefined()
    const replacement = acquireAgentSession(state.db, 's', () => true)!
    release()
    expect(acquireAgentSession(state.db, 's', () => false)).toBeUndefined()
    replacement()
    expect(acquireAgentSession(state.db, 's')).toBeTypeOf('function')
  })
  it('rejects a second run in the same session and releases the lock after completion', async () => {
    let finish!: () => void
    state.run.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve })).mockResolvedValue(undefined)
    const body = { sessionId: 'exclusive-test', messages: [{ role: 'user', content: 'test' }] }
    const first = request(app.callback()).post('/').send(body).then(response => response)
    await vi.waitFor(() => expect(state.run).toHaveBeenCalledTimes(1))
    const second = await request(app.callback()).post('/').send(body)
    expect(second.status).toBe(409)
    expect(second.body.error).toBe('session_agent_busy')
    finish()
    expect((await first).status).toBe(200)
    expect((await request(app.callback()).post('/').send(body)).status).toBe(200)
    expect(state.run).toHaveBeenCalledTimes(2)
  })
})
