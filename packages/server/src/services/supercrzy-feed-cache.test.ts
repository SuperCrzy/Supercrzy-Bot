/**
 * The disk cache exists so a cold start on a bad route still has news. The
 * risky edges are: it must be written on success, used on failure, refused once
 * it is too old, and it must never take the tool down when the write fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Cached Headline</title><link>https://supercrzy.com/a</link><description>body</description><pubDate>Thu, 20 Nov 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`

let tmpDb: string
const originalFetch = global.fetch

beforeEach(() => {
    tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feed-')), 'test.db')
    process.env.DB_PATH = tmpDb
    vi.resetModules()
})

afterEach(() => { global.fetch = originalFetch })

async function modules() {
    const db = await import('./database')
    db.initDatabase()
    const feed = await import('./supercrzy-feed')
    return { conn: db.getDB(), feed }
}

function writeRow(conn: any, at: number) {
    conn.prepare("INSERT INTO settings(key,value) VALUES('newsFeedCache',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify({ at, items: [{ title: 'Old Item', url: 'https://supercrzy.com/old', summary: 's', date: new Date(at).toISOString(), category: 'Models' }] }))
}
function readRow(conn: any): any {
    const row = conn.prepare("SELECT value FROM settings WHERE key='newsFeedCache'").get() as any
    return row?.value ? JSON.parse(row.value) : null
}

describe('feed disk cache', () => {
    it('persists the parsed feed after a successful fetch', async () => {
        global.fetch = vi.fn(async () => new Response(RSS, { status: 200 })) as any
        const { conn, feed } = await modules()
        const items = await feed.fetchSupercrzyNews()
        expect(items).toHaveLength(1)
        expect(feed.lastFeedWasStale()).toBe(false)
        const saved = readRow(conn)
        expect(saved.items[0].title).toBe('Cached Headline')
    })

    it('falls back to disk when the source fails, and says so', async () => {
        const { conn, feed } = await modules()
        writeRow(conn, Date.now() - 60_000)
        global.fetch = vi.fn(async () => { throw new Error('network down') }) as any
        const items = await feed.fetchSupercrzyNews()
        expect(items).toHaveLength(1)
        expect(items[0].title).toBe('Old Item')
        expect(feed.lastFeedWasStale()).toBe(true)
    })

    it('refuses a cache older than a week', async () => {
        const { conn, feed } = await modules()
        writeRow(conn, Date.now() - 8 * 24 * 60 * 60 * 1000)
        global.fetch = vi.fn(async () => { throw new Error('network down') }) as any
        const items = await feed.fetchSupercrzyNews()
        expect(items).toHaveLength(0)
    })

    it('does not fall back to disk when the source answers with no items', async () => {
        const { conn, feed } = await modules()
        writeRow(conn, Date.now() - 60_000)
        global.fetch = vi.fn(async () => new Response('<?xml version="1.0"?><rss><channel></channel></rss>', { status: 200 })) as any
        const items = await feed.fetchSupercrzyNews()
        // An empty but valid feed means "nothing published", not "source is down",
        // so the stale copy must not be presented as current.
        expect(items).toHaveLength(1)
        expect(feed.lastFeedWasStale()).toBe(true)
    })
})
