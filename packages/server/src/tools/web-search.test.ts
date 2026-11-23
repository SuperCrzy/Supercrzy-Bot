import { beforeEach, describe, expect, it, vi } from 'vitest'

const search = vi.hoisted(() => ({ runSearchChain: vi.fn(), runExhaustiveSearch: vi.fn() }))
vi.mock('../services/search-providers', () => search)
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
})
