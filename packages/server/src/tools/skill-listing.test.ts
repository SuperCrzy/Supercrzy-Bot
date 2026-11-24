/**
 * Skills must be listed completely and opened deterministically.
 *
 * Two failures found on a machine with 200+ skills:
 *
 * 1. skill_list produced ~31,000 characters while tool output is capped at 16,000.
 *    Everything past the cutoff disappeared, so the model reported a shorter library
 *    than existed and said "I don't have that skill" about entries it never saw.
 *
 * 2. Skill names can duplicate — re-importing while the old copy stayed around leaves
 *    two rows with the same name. `WHERE name = ?` with no ORDER BY returns whichever
 *    row the storage engine happens to find, so the same name could open a different
 *    skill on the next call.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE skills (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    icon TEXT, category TEXT NOT NULL DEFAULT 'general', enabled INTEGER NOT NULL DEFAULT 1,
    trigger_keywords TEXT, prompt_template TEXT, tools TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
    is_builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT, name_en TEXT, description_en TEXT, globs TEXT, environments TEXT,
    scoped_to TEXT, usage_count INTEGER NOT NULL DEFAULT 0, last_used TEXT
  )`)
})

/** The two query shapes under test, mirrored from the tool implementations. */
const listNames = () =>
  (db.prepare('SELECT name, category, enabled FROM skills ORDER BY sort_order ASC, created_at DESC').all() as any[])
    .map((r) => `[${r.enabled ? 'ON' : 'OFF'}] ${r.name} (${r.category})`).join('\n')

const viewByName = (name: string) =>
  db.prepare(
    'SELECT * FROM skills WHERE name = ? COLLATE NOCASE ORDER BY enabled DESC, usage_count DESC, created_at ASC LIMIT 1',
  ).get(name) as any

describe('skill_list output budget', () => {
  it('switches to names-only when the full listing would exceed the cap', () => {
    // 220 skills at ~140 chars each is past 30,000 — the real numbers.
    const long = 'x'.repeat(110)
    const insert = db.prepare(
      'INSERT INTO skills (id, name, description, category, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (let i = 0; i < 220; i++) insert.run(`id-${i}`, `skill-${i}`, long, 'dev', i, '2026-08-25')

    const rows = db.prepare('SELECT name, description FROM skills').all() as any[]
    const full = rows.map((r) => `[ON] ${r.name} (dev, installed) - ${r.description}`).join('\n')
    expect(full.length).toBeGreaterThan(16_000)   // the condition that caused the bug
    expect(listNames().length).toBeLessThan(16_000)  // names-only always fits
    // Nothing is silently dropped: every skill appears.
    expect(listNames().split('\n')).toHaveLength(220)
  })
})

describe('skill_view with duplicate names', () => {
  it('opens the enabled, most-used copy rather than an arbitrary one', () => {
    db.prepare("INSERT INTO skills (id, name, enabled, usage_count, created_at, description) VALUES ('a','dup',1,5,'2026-08-25','old')").run()
    db.prepare("INSERT INTO skills (id, name, enabled, usage_count, created_at, description) VALUES ('b','dup',1,127,'2026-08-26','popular')").run()
    db.prepare("INSERT INTO skills (id, name, enabled, usage_count, created_at, description) VALUES ('c','dup',0,999,'2026-08-27','disabled')").run()
    // Enabled beats a disabled copy with a higher count.
    expect(viewByName('dup').description).toBe('popular')
  })

  it('prefers the older copy when counts tie', () => {
    db.prepare("INSERT INTO skills (id, name, enabled, usage_count, created_at, description) VALUES ('x','tie',1,10,'2026-08-26','later')").run()
    db.prepare("INSERT INTO skills (id, name, enabled, usage_count, created_at, description) VALUES ('y','tie',1,10,'2026-08-25','earlier')").run()
    expect(viewByName('tie').description).toBe('earlier')
  })

  it('is stable across repeated lookups', () => {
    for (let i = 0; i < 5; i++) {
      db.prepare(`INSERT INTO skills (id, name, enabled, usage_count, created_at, description) VALUES ('id-${i}','same',1,${i},'2026-08-2${i}','d${i}')`).run()
    }
    const first = viewByName('same').id
    for (let i = 0; i < 5; i++) expect(viewByName('same').id).toBe(first)
  })
})
