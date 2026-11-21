/**
 * The migration silently rewrites a settings row on every existing install, so
 * the two things that matter are: it fixes exactly the broken value, and it
 * never touches a configuration the user chose deliberately.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let tmpDb: string

beforeEach(() => {
    tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'searchmig-')), 'test.db')
    process.env.DB_PATH = tmpDb
    vi.resetModules()
})

async function freshModules() {
    const db = await import('./database')
    db.initDatabase()
    const mig = await import('./search-settings-migration')
    return { db, mig, conn: db.getDB() }
}

function set(conn: any, key: string, value: string) {
    conn.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
function read(conn: any, key: string): string {
    return (conn.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any)?.value ?? ''
}

describe('search settings migration', () => {
    it('rewrites a primary pointing at the unreachable mainland host', async () => {
        const { mig, conn } = await freshModules()
        set(conn, 'searxngUrl', 'http://116.181.17.27/searxng')
        mig.migrateSearchSettings()
        expect(read(conn, 'searxngUrl')).toBe('http://107.174.107.199:8080')
    })

    it('clears the mainland host out of the secondary slot', async () => {
        const { mig, conn } = await freshModules()
        set(conn, 'searxngUrl', 'http://107.174.107.199:8080')
        set(conn, 'searxngUrlGlobal', 'http://116.181.17.27/searxng')
        mig.migrateSearchSettings()
        expect(read(conn, 'searxngUrlGlobal')).toBe('')
    })

    it('fills an empty primary so a fresh install can search', async () => {
        const { mig, conn } = await freshModules()
        mig.migrateSearchSettings()
        expect(read(conn, 'searxngUrl')).toBe('http://107.174.107.199:8080')
    })

    it('leaves a self-hosted instance alone', async () => {
        const { mig, conn } = await freshModules()
        set(conn, 'searxngUrl', 'https://search.mydomain.com')
        mig.migrateSearchSettings()
        expect(read(conn, 'searxngUrl')).toBe('https://search.mydomain.com')
    })

    it('runs only once, so a later manual choice survives a restart', async () => {
        const { mig, conn } = await freshModules()
        mig.migrateSearchSettings()
        set(conn, 'searxngUrl', 'http://116.181.17.27/searxng')
        mig.migrateSearchSettings()
        expect(read(conn, 'searxngUrl')).toBe('http://116.181.17.27/searxng')
    })
})
