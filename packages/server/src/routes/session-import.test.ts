import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import request from 'supertest'

const state = vi.hoisted(() => ({ accountId: 'owner', signedIn: true, db: null as any }))
vi.mock('../services/database', () => ({ getDB: () => state.db }))
vi.mock('../services/account-store', () => ({ isSignedIn: () => state.signedIn, readSession: () => ({ accountId: state.accountId }) }))
import { sessionRouter } from './session'

const app = new Koa().use(bodyParser()).use(sessionRouter.routes())
const fixture = { id: 's1', title: 'one', model: 'model', createdAt: '2026-01-01', updatedAt: '2026-01-02', messages: [] }
beforeEach(() => {
  state.signedIn = true
  state.accountId = 'owner'
  state.db = new Database(':memory:')
  state.db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, model TEXT, created_at TEXT, updated_at TEXT, archived INTEGER NOT NULL DEFAULT 0); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT, attachments TEXT)')
})
afterEach(() => state.db.close())

describe('session import route', () => {
  it('rejects invalid archive updates and updates to missing sessions', async () => {
    expect((await request(app.callback()).patch('/api/sessions/missing').send({ archived: true })).status).toBe(404)
    await request(app.callback()).post('/api/sessions/import').set('X-Supercrzy-Account', 'owner').send(fixture)
    expect((await request(app.callback()).patch('/api/sessions/s1').send({ archived: 'false' })).status).toBe(400)
    expect(state.db.prepare('SELECT archived FROM sessions WHERE id = ?').get('s1')).toEqual({ archived: 0 })
    expect((await request(app.callback()).patch('/api/sessions/s1').send({ archived: true })).status).toBe(200)
    expect(state.db.prepare('SELECT archived FROM sessions WHERE id = ?').get('s1')).toEqual({ archived: 1 })
  })
  it('requires the current account and preserves already imported sessions', async () => {
    expect((await request(app.callback()).post('/api/sessions/import').set('X-Supercrzy-Account', 'other').send(fixture)).status).toBe(409)
    expect((await request(app.callback()).post('/api/sessions/import').set('X-Supercrzy-Account', 'owner').send(fixture)).status).toBe(201)
    const repeated = await request(app.callback()).post('/api/sessions/import').set('X-Supercrzy-Account', 'owner').send({ ...fixture, title: 'replacement' })
    expect(repeated.status).toBe(409)
    expect(repeated.body.result).toBe('exists')
    expect(state.db.prepare('SELECT title FROM sessions').get()).toEqual({ title: 'one' })
    state.signedIn = false
    expect((await request(app.callback()).post('/api/sessions/import').set('X-Supercrzy-Account', 'owner').send(fixture)).status).toBe(401)
  })
})
