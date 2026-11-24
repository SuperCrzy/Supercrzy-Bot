import { afterEach, describe, expect, it, vi } from 'vitest'
import { postProcessSearchResults, runExhaustiveSearch, runSearchChain, SEARCH_PROVIDERS, type SearchProvider } from './search-providers'

const original = [...SEARCH_PROVIDERS]
afterEach(() => { SEARCH_PROVIDERS.splice(0, SEARCH_PROVIDERS.length, ...original); vi.unstubAllGlobals() })
const provider = (name: string, rows: Array<{ title: string; url: string; date?: string }>): SearchProvider => ({
  name, enabled: async () => true, search: async () => rows,
})
const rows = [
  { title: 'unknown', url: 'https://a.example/1' },
  { title: 'bad date', url: 'https://b.example/1', date: 'unknown' },
  { title: 'old', url: 'https://c.example/1', date: '2026-11-20' },
  { title: 'new', url: 'https://d.example/1', date: '2026年11月23日' },
]

describe('search result ordering and fallback', () => {
  it('keeps distinct stories sharing a long title prefix and deduplicates the same URL', () => {
    const input = [
      { title: '人工智能行业观察报告发布北京篇', url: 'https://a.example/a' },
      { title: '人工智能行业观察报告发布上海篇', url: 'https://b.example/b' },
      { title: '另一个标题', url: 'https://a.example/a#fragment' },
    ]
    expect(postProcessSearchResults(input, 10).map(r => r.title)).toEqual(input.slice(0, 2).map(r => r.title))
  })

  it('uses the same title and URL deduplication for multi-source results', async () => {
    const input = [
      { title: '人工智能行业观察报告发布北京篇', url: 'https://a.example/a' },
      { title: '人工智能行业观察报告发布上海篇', url: 'https://b.example/b' },
      { title: '人工智能行业观察报告发布北京篇', url: 'https://c.example/c' },
    ]
    SEARCH_PROVIDERS.splice(0, SEARCH_PROVIDERS.length, provider('test', input))
    expect((await runExhaustiveSearch({ query: 'test', count: 10 })).results.map(r => r.title)).toEqual(input.slice(0, 2).map(r => r.title))
  })
  it('puts parseable dates ahead of unknown dates in ordinary search', () => {
    expect(postProcessSearchResults(rows, 4).map(r => r.title)).toEqual(['new', 'old', 'unknown', 'bad date'])
  })

  it('sorts parseable dates newest first in multi-source search', async () => {
    SEARCH_PROVIDERS.splice(0, SEARCH_PROVIDERS.length, provider('test', rows))
    const result = await runExhaustiveSearch({ query: 'test', count: 4 })
    expect(result.results.map(r => r.title)).toEqual(['new', 'old', 'unknown', 'bad date'])
  })

  it('filters known stale dates but retains undated results for verification', async () => {
    const now = Date.now()
    const items = [
      { title: 'old', url: 'https://a.example/', date: new Date(now - 10 * 86400000).toISOString() },
      { title: 'recent', url: 'https://b.example/', date: new Date(now - 2 * 86400000).toISOString() },
      { title: 'unknown', url: 'https://c.example/' },
    ]
    SEARCH_PROVIDERS.splice(0, SEARCH_PROVIDERS.length, provider('test', items))
    const result = await runExhaustiveSearch({ query: 'test', count: 4, timeRange: 'week' })
    expect(result.results.map(r => r.title)).toEqual(['recent', 'unknown'])
  })

  it('tries the next provider when the first has no usable results', async () => {
    SEARCH_PROVIDERS.splice(0, SEARCH_PROVIDERS.length, provider('empty', [{ title: '', url: 'https://a.example/' }]), provider('good', [rows[0]]))
    const result = await runSearchChain({ query: 'test', count: 4 })
    expect(result.engine).toBe('good')
    expect(result.results).toEqual([rows[0]])
  })

  it('tries the next provider when an availability check fails', async () => {
    const broken: SearchProvider = { name: 'broken', enabled: async () => { throw new Error('offline') }, search: async () => [] }
    SEARCH_PROVIDERS.splice(0, SEARCH_PROVIDERS.length, broken, provider('good', [rows[0]]))
    expect((await runSearchChain({ query: 'test', count: 4 })).engine).toBe('good')
  })

  it('uses one bounded signal for both Bing redirect requests', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://cn.bing.com/search?q=test' } }))
      .mockResolvedValueOnce(new Response('<rss></rss>'))
    vi.stubGlobal('fetch', fetcher)
    await original.find(p => p.name === 'bing')!.search({ query: 'test', count: 4 })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(fetcher.mock.calls[1][1].signal).toBe(fetcher.mock.calls[0][1].signal)
  })
})
