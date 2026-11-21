/**
 * Bing was the only fallback left when SearXNG died, and it answered with a 302
 * to the regional host. With `redirect: 'follow'` that bounced until it gave up,
 * so the tool reported "no results" while Bing was actually reachable. These
 * tests pin down the single-hop behaviour and the loop guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { initDatabase } from './database'

const RSS = `<?xml version="1.0"?><rss><channel>
<item><title>Result One</title><link>https://example.com/1</link><description>desc one</description></item>
<item><title>Result Two</title><link>https://example.com/2</link><description>desc two</description></item>
</channel></rss>`

describe('bing provider redirect handling', () => {
    const originalFetch = global.fetch

    beforeEach(() => { initDatabase() })
    afterEach(() => { global.fetch = originalFetch })

    async function bing() {
        const mod = await import('./search-providers')
        return mod.SEARCH_PROVIDERS.find(p => p.name === 'bing')!
    }

    it('follows exactly one redirect to the regional host and parses the feed', async () => {
        const calls: string[] = []
        global.fetch = vi.fn(async (url: any) => {
            calls.push(String(url))
            if (String(url).includes('www.bing.com')) {
                return new Response(null, { status: 302, headers: { location: 'https://cn.bing.com/search?format=rss&q=x' } })
            }
            return new Response(RSS, { status: 200 })
        }) as any

        const rows = await (await bing()).search({ query: 'x', count: 5 } as any)
        expect(calls).toHaveLength(2)
        expect(calls[1]).toContain('cn.bing.com')
        expect(rows).toHaveLength(2)
        expect(rows[0].title).toBe('Result One')
    })

    it('gives up on a self-redirect instead of looping', async () => {
        let n = 0
        global.fetch = vi.fn(async (url: any) => {
            n += 1
            return new Response(null, { status: 302, headers: { location: String(url) } })
        }) as any

        const rows = await (await bing()).search({ query: 'x', count: 5 } as any)
        expect(rows).toHaveLength(0)
        expect(n).toBeLessThanOrEqual(2)
    })

    it('gives up when the second hop is also a redirect', async () => {
        global.fetch = vi.fn(async (url: any) => {
            if (String(url).includes('www.bing.com')) {
                return new Response(null, { status: 302, headers: { location: 'https://cn.bing.com/a' } })
            }
            return new Response(null, { status: 302, headers: { location: 'https://cn.bing.com/b' } })
        }) as any

        const rows = await (await bing()).search({ query: 'x', count: 5 } as any)
        expect(rows).toHaveLength(0)
    })

    it('returns nothing when a redirect carries no location', async () => {
        global.fetch = vi.fn(async () => new Response(null, { status: 302 })) as any
        const rows = await (await bing()).search({ query: 'x', count: 5 } as any)
        expect(rows).toHaveLength(0)
    })
})
