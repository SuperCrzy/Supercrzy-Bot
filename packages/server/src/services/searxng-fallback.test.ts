import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings: Record<string, string> = {}
vi.mock('./database', () => ({
  getDB: () => ({
    prepare: () => ({ get: (k: string) => (settings[k] ? { value: settings[k] } : undefined) }),
  }),
}))

const { SEARCH_PROVIDERS, resetDeadInstances } = await import('./search-providers')

const searxng = () => SEARCH_PROVIDERS.find((p) => p.name === 'searxng')!
const ok = (title: string) => ({
  ok: true,
  json: async () => ({ results: [{ title, url: 'https://example.com/' + title, content: 'x' }] }),
})

describe('searxng dual-instance routing', () => {
  beforeEach(() => {
    resetDeadInstances()
    for (const k of Object.keys(settings)) delete settings[k]
    vi.restoreAllMocks()
  })

  it('English queries hit the primary instance first', async () => {
    settings.searxngUrl = 'http://primary'
    settings.searxngUrlGlobal = 'http://secondary'
    const calls: string[] = []
    vi.stubGlobal('fetch', async (u: string) => { calls.push(u); return ok('p') })
    const rows = await searxng().search({ query: 'kubernetes', count: 5 })
    expect(rows).toHaveLength(1)
    expect(calls[0]).toContain('http://primary')
    expect(calls).toHaveLength(1)
  })

  it('Chinese queries try the secondary first, then fall back', async () => {
    settings.searxngUrl = 'http://primary'
    settings.searxngUrlGlobal = 'http://secondary'
    const calls: string[] = []
    vi.stubGlobal('fetch', async (u: string) => {
      calls.push(u)
      if (u.startsWith('http://secondary')) throw new Error('ECONNRESET')
      return ok('p')
    })
    const rows = await searxng().search({ query: '人工智能政策', count: 5 })
    expect(rows).toHaveLength(1)
    expect(calls[0]).toContain('http://secondary')
    expect(calls[1]).toContain('http://primary')
  })

  it('a dead instance is skipped on the next search instead of timing out again', async () => {
    settings.searxngUrl = 'http://primary'
    settings.searxngUrlGlobal = 'http://secondary'
    let secondaryHits = 0
    vi.stubGlobal('fetch', async (u: string) => {
      if (u.startsWith('http://secondary')) { secondaryHits++; throw new Error('ETIMEDOUT') }
      return ok('p')
    })
    await searxng().search({ query: '人工智能', count: 5 })
    const t0 = Date.now()
    await searxng().search({ query: '人工智能再试', count: 5 })
    expect(secondaryHits).toBe(1) // not retried within the dead TTL
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
