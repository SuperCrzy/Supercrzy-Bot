/**
 * One-shot migration for the search settings.
 *
 * Context (measured 2026-11-20): the primary SearXNG instance was pointed at
 * the mainland host (116.181.17.27), which answers locally but is unreachable
 * from outside mainland China — every query timed out and web_search returned
 * zero results. The overseas instance (107.174.107.199:8080) answers in ~1s.
 *
 * Per-machine rows meant fixing one database left every other install broken,
 * so the correction belongs in code rather than in someone's settings table.
 * Runs once, tracked by `searchSettingsMigratedV2`.
 */
import { getDB } from './database'

const MARKER_KEY = 'searchSettingsMigratedV2'
const OVERSEAS_INSTANCE = 'http://107.174.107.199:8080'
const DEAD_MAINLAND_HOST = '116.181.17.27'

export function migrateSearchSettings(): void {
    let db
    try {
        db = getDB()
    } catch {
        return
    }

    const read = (key: string): string => {
        try {
            const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
            return row?.value ? String(row.value).trim() : ''
        } catch {
            return ''
        }
    }
    const write = (key: string, value: string): void => {
        try {
            db.prepare(
                'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
            ).run(key, value)
        } catch (err) {
            console.warn('[search-migration] could not write', key, err instanceof Error ? err.message : err)
        }
    }

    if (read(MARKER_KEY) === '1') return

    const primary = read('searxngUrl')
    const secondary = read('searxngUrlGlobal')

    // An unset primary means search falls through to the keyless engines only;
    // point it at the self-hosted instance so a fresh install works out of the box.
    if (!primary || primary.includes(DEAD_MAINLAND_HOST)) {
        write('searxngUrl', OVERSEAS_INSTANCE)
        console.log('[search-migration] primary SearXNG ->', OVERSEAS_INSTANCE, '(was:', primary || 'unset', ')')
    }

    // Leaving the mainland host in the secondary slot only costs a 6s timeout on
    // every CJK query before the fallback runs, so clear it until it is reachable.
    if (secondary.includes(DEAD_MAINLAND_HOST)) {
        write('searxngUrlGlobal', '')
        console.log('[search-migration] cleared unreachable secondary SearXNG:', secondary)
    }

    write(MARKER_KEY, '1')
}
