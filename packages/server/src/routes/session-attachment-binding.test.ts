import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import request from 'supertest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('../services/database', () => ({ getDB: () => state.db }))
import { sessionRouter } from './session'
const app = new Koa(); app.use(bodyParser()); app.use(sessionRouter.routes())
beforeEach(() => {
  state.db = new Database(':memory:')
  state.db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at TEXT, title TEXT, model TEXT, workspace_dir TEXT, permission_level TEXT, collab_mode TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, token_count INTEGER, token_estimated INTEGER, cost REAL, elapsed_ms INTEGER, model TEXT, attachments TEXT);
    CREATE TABLE uploads (id TEXT PRIMARY KEY, session_id TEXT);
    INSERT INTO sessions (id) VALUES ('a'), ('b');
    INSERT INTO uploads VALUES ('welcome', NULL), ('other', 'b');`)
})
afterEach(() => state.db.close())

describe('message attachment association', () => {
  it('rolls back session creation when workspace indexing fails', async () => {
    // No workspaces table: indexing fails after the session insert.
    const response = await request(app.callback()).post('/api/sessions').send({ id: 'new', title: 'test', workspace_dir: '/tmp/test-workspace' })
    expect(response.status).toBe(500)
    expect(state.db.prepare('SELECT id FROM sessions WHERE id = ?').get('new')).toBeUndefined()
  })
  it('associates previously unassigned files without moving another session’s file', async () => {
    const response = await request(app.callback()).post('/api/sessions/a/messages').send({ id: 'message', role: 'user', content: 'hello', attachments: [{ id: 'welcome' }, { id: 'other' }] })
    expect(response.status).toBe(201)
    expect(state.db.prepare('SELECT session_id FROM uploads WHERE id = ?').get('welcome')).toEqual({ session_id: 'a' })
    expect(state.db.prepare('SELECT session_id FROM uploads WHERE id = ?').get('other')).toEqual({ session_id: 'b' })
  })
  it('rolls back the message if associating its upload fails', async () => {
    state.db.exec("CREATE TRIGGER fail_binding BEFORE UPDATE ON uploads BEGIN SELECT RAISE(FAIL, 'binding failure'); END")
    const response = await request(app.callback()).post('/api/sessions/a/messages').send({ id: 'message', role: 'user', content: 'hello', attachments: [{ id: 'welcome' }] })
    expect(response.status).toBe(500)
    expect(state.db.prepare('SELECT count(*) AS count FROM messages').get().count).toBe(0)
    expect(state.db.prepare('SELECT session_id FROM uploads WHERE id = ?').get('welcome')).toEqual({ session_id: null })
  })
})
