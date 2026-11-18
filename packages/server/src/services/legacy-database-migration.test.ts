import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateLegacyDatabase } from './legacy-database-migration'

const directories: string[] = []
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'supercrzy-db-migration-'))
  directories.push(path)
  return path
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('legacy database migration', () => {
  it('includes committed rows still in the WAL and leaves the original intact', () => {
    const dir = directory()
    const sourcePath = join(dir, 'old.db')
    const destinationPath = join(dir, 'new.db')
    const source = new Database(sourcePath)
    try {
      source.pragma('journal_mode = WAL')
      source.pragma('wal_autocheckpoint = 0')
      source.exec("CREATE TABLE sessions (id TEXT); INSERT INTO sessions VALUES ('wal-only')")
      migrateLegacyDatabase(sourcePath, destinationPath)
      const copied = new Database(destinationPath, { readonly: true })
      try {
        expect(copied.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'wal-only' }])
        expect(source.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'wal-only' }])
      } finally { copied.close() }
      expect(readdirSync(dir).filter((name) => name.includes('.migration-'))).toEqual([])
    } finally { source.close() }
  })

  it('does not overwrite an existing destination', () => {
    const dir = directory()
    const sourcePath = join(dir, 'old.db')
    const destinationPath = join(dir, 'new.db')
    const source = new Database(sourcePath)
    source.exec("CREATE TABLE data (value TEXT); INSERT INTO data VALUES ('old')")
    source.close()
    const destination = new Database(destinationPath)
    destination.exec("CREATE TABLE data (value TEXT); INSERT INTO data VALUES ('existing')")
    destination.close()
    expect(() => migrateLegacyDatabase(sourcePath, destinationPath)).toThrow()
    const check = new Database(destinationPath, { readonly: true })
    try { expect(check.prepare('SELECT value FROM data').all()).toEqual([{ value: 'existing' }]) } finally { check.close() }
    expect(readdirSync(dir).filter((name) => name.includes('.migration-'))).toEqual([])
  })

  it('preserves external-content search results and message ordering', () => {
    const dir = directory()
    const sourcePath = join(dir, 'old.db')
    const destinationPath = join(dir, 'new.db')
    const source = new Database(sourcePath)
    try {
      source.exec(`
        CREATE TABLE agent_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL);
        CREATE VIRTUAL TABLE agent_memory_fts USING fts5(content, content='agent_memory', content_rowid='rowid');
        INSERT INTO agent_memory VALUES ('removed', 'alpha'), ('kept', 'bravo');
        INSERT INTO agent_memory_fts(rowid, content) SELECT rowid, content FROM agent_memory;
        INSERT INTO agent_memory_fts(agent_memory_fts, rowid, content) VALUES ('delete', 1, 'alpha');
        DELETE FROM agent_memory WHERE id = 'removed';
        CREATE TABLE messages (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
        INSERT INTO messages VALUES ('removed', 'same'), ('first', 'same'), ('second', 'same');
        DELETE FROM messages WHERE id = 'removed';
      `)
      migrateLegacyDatabase(sourcePath, destinationPath)
      const copied = new Database(destinationPath, { readonly: true })
      try {
        expect(copied.prepare("SELECT m.id FROM agent_memory_fts f JOIN agent_memory m ON m.rowid = f.rowid WHERE agent_memory_fts MATCH 'bravo'").all()).toEqual([{ id: 'kept' }])
        expect(copied.prepare('SELECT id FROM messages ORDER BY created_at, rowid').all()).toEqual([{ id: 'first' }, { id: 'second' }])
      } finally { copied.close() }
    } finally { source.close() }
  })

  it('fails without creating a destination when the old database is invalid', () => {
    const dir = directory()
    const sourcePath = join(dir, 'old.db')
    writeFileSync(sourcePath, 'not a sqlite database')
    expect(() => migrateLegacyDatabase(sourcePath, join(dir, 'new.db'))).toThrow()
    expect(readdirSync(dir)).toEqual(['old.db'])
  })
})
