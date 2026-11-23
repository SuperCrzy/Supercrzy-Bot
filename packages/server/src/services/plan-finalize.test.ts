import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { finalizePlan } from './plan-finalize'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT, parent_id TEXT, subject TEXT, status TEXT, sort_order INTEGER, created_at TEXT);
    INSERT INTO tasks VALUES ('p', 's', NULL, 'plan', 'in_progress', 0, '2026-01-01');
    INSERT INTO tasks VALUES ('a', 's', 'p', 'first', 'completed', 0, '2026-01-01');
    INSERT INTO tasks VALUES ('b', 's', 'p', 'second', 'in_progress', 1, '2026-01-01');`)
})
afterEach(() => db.close())

describe('plan finalization', () => {
  it.each([true, false])('preserves unfinished steps even when the stream ends (success=%s)', success => {
    const snapshot = finalizePlan(db, 's', success)
    expect(snapshot?.steps.map(s => s.status)).toEqual(['completed', 'in_progress'])
    expect(db.prepare("SELECT status FROM tasks WHERE id='p'").get()).toEqual({ status: 'in_progress' })
  })
  it('only closes a fully declared plan after a successful run', () => {
    db.prepare("UPDATE tasks SET status='completed' WHERE id='b'").run()
    finalizePlan(db, 's', false)
    expect(db.prepare("SELECT status FROM tasks WHERE id='p'").get()).toEqual({ status: 'in_progress' })
    finalizePlan(db, 's', true)
    expect(db.prepare("SELECT status FROM tasks WHERE id='p'").get()).toEqual({ status: 'completed' })
  })
})
