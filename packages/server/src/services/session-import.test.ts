import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { importCloudSession } from './session-import'

let db: Database.Database
const fixture = { id: 's1', title: 'Session', model: 'model', createdAt: '2026-01-01', updatedAt: '2026-01-02', messages: [
  { id: 'm1', role: 'user', content: 'hello', createdAt: '2026-01-01' },
  { id: 'm2', role: 'assistant', content: 'answer', createdAt: '2026-01-02' },
] }
beforeEach(() => {
  db = new Database(':memory:')
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT, updated_at TEXT, archived INTEGER NOT NULL DEFAULT 0); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT, attachments TEXT)')
})
afterEach(() => db.close())

describe('cloud session import', () => {
  it('imports once and does not change an existing local session', () => {
    expect(importCloudSession(db, fixture)).toBe('created')
    expect(importCloudSession(db, { ...fixture, title: 'changed' })).toBe('exists')
    expect(db.prepare('SELECT title FROM sessions').get()).toEqual({ title: 'Session' })
    expect(db.prepare('SELECT content FROM messages ORDER BY rowid').all()).toEqual([{ content: 'hello' }, { content: 'answer' }])
  })
  it('rolls back the entire session if a message ID belongs to another session', () => {
    db.prepare("INSERT INTO messages VALUES ('m2', 'existing', 'user', 'keep', '2026-01-01', NULL)").run()
    expect(() => importCloudSession(db, fixture)).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT content FROM messages').get()).toEqual({ content: 'keep' })
  })
  it('rejects malformed messages before creating a session', () => {
    expect(() => importCloudSession(db, { ...fixture, messages: [{ ...fixture.messages[0], role: 'invalid' }] })).toThrow('invalid_message')
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  })
  it('restores execution metadata and accepts old messages without it', () => {
    const attachments = { flow: [{ kind: 'tool', tool: { name: 'search' } }], deliverySummary: { text: 'done' } }
    expect(importCloudSession(db, { ...fixture, messages: [fixture.messages[0], { ...fixture.messages[1], attachments }] })).toBe('created')
    const rows = db.prepare('SELECT attachments FROM messages ORDER BY rowid').all() as Array<{ attachments: string | null }>
    expect(rows[0].attachments).toBeNull()
    expect(JSON.parse(rows[1].attachments!)).toEqual(attachments)
  })
  it('rejects invalid metadata without partially importing', () => {
    expect(() => importCloudSession(db, { ...fixture, messages: [{ ...fixture.messages[0], attachments: 'invalid' }] })).toThrow('invalid_message')
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  })
  it('preserves archived status and defaults older backups to active', () => {
    expect(importCloudSession(db, { ...fixture, archived: true })).toBe('created')
    expect(db.prepare('SELECT archived FROM sessions WHERE id = ?').get(fixture.id)).toEqual({ archived: 1 })
    expect(importCloudSession(db, { ...fixture, id: 'legacy', messages: [] })).toBe('created')
    expect(db.prepare('SELECT archived FROM sessions WHERE id = ?').get('legacy')).toEqual({ archived: 0 })
    expect(() => importCloudSession(db, { ...fixture, id: 'invalid', archived: 'true' })).toThrow('invalid_session')
  })
})
