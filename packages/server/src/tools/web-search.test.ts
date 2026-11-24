import { beforeEach, describe, expect, it, vi } from 'vitest'

const search = vi.hoisted(() => ({ runSearchChain: vi.fn(), runExhaustiveSearch: vi.fn() }))
vi.mock('../services/search-providers', async importOriginal => ({ ...await importOriginal<typeof import('../services/search-providers')>(), ...search }))
import tool from './web-search'

describe('web_search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    search.runSearchChain.mockResolvedValue({ engine: 'test', results: [] })
    search.runExhaustiveSearch.mockResolvedValue({ engine: 'test', engines: [], results: [] })
  })

  it('bounds the result count before passing it to providers', async () => {
    for (const count of [-1, 0, NaN, Infinity, '2']) {
      await tool.execute({ query: 'example', count })
      expect(search.runSearchChain).toHaveBeenLastCalledWith(expect.objectContaining({ count: 8 }))
    }
    await tool.execute({ query: 'example', count: 100 })
    expect(search.runSearchChain).toHaveBeenLastCalledWith(expect.objectContaining({ count: 10 }))
    await tool.execute({ query: 'example', count: 3.9 })
    expect(search.runSearchChain).toHaveBeenLastCalledWith(expect.objectContaining({ count: 3 }))
  })

  it('passes the bounded count and time range to the fresh news search', async () => {
    await tool.execute({ query: '新闻', count: -1, timeRange: 'day' })
    expect(search.runExhaustiveSearch).toHaveBeenCalledWith(expect.objectContaining({ count: 8, timeRange: 'day', source: 'news' }))
  })

  it('does not claim an empty response proves that no matching pages exist', async () => {
    const result = JSON.parse(await tool.execute({ query: 'example' }))
    expect(result.message).toContain('来源暂时不可用')
  })

  it.each(['ordinary', 'fresh'])('labels unknown and unverified dates in %s results', async mode => {
    const results = [{ title: 'unknown', url: 'https://a.example', date: '2026-02-30' }, { title: 'dated', url: 'https://b.example', date: '2026-11-23' }]
    if (mode === 'fresh') search.runExhaustiveSearch.mockResolvedValue({ engine: 'test', engines: ['test'], results })
    else search.runSearchChain.mockResolvedValue({ engine: 'test', results })
    const output = JSON.parse(await tool.execute({ query: 'example', ...(mode === 'fresh' ? { timeRange: 'day' } : {}) }))
    expect(output.results.map((result: { date_status: string }) => result.date_status)).toEqual(['unknown', 'unverified'])
    if (mode === 'fresh') expect(output.date_note).toContain('不能确认符合时间范围')
  })
})
