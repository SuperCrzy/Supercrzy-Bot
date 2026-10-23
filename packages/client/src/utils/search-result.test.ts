import { describe, it, expect } from 'vitest'
import { parseSearchPayload } from './search-result'

const payload = (results: any[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ query: 'AI 芯片出口', engine: 'tavily', results, ...extra })

describe('parseSearchPayload', () => {
  it('正常载荷：标题/链接/域名/摘要/日期都能取出来', () => {
    const p = parseSearchPayload(
      payload([
        { title: '美国收紧对华 AI 芯片出口', url: 'https://www.reuters.com/a', content: '新规覆盖加速卡', date: '2026-10-23' },
      ]),
    )
    expect(p?.query).toBe('AI 芯片出口')
    expect(p?.engine).toBe('tavily')
    expect(p?.results[0]).toEqual({
      title: '美国收紧对华 AI 芯片出口',
      url: 'https://www.reuters.com/a',
      domain: 'reuters.com', // www. 必须去掉，域名是给用户看的信任信号
      snippet: '新规覆盖加速卡',
      date: '2026-10-23',
    })
  })

  it('不同 provider 的字段名都能吃（snippet/description、link、publishedAt）', () => {
    const p = parseSearchPayload(
      payload([
        { title: 'A', link: 'https://a.com/x', snippet: 'sa' },
        { title: 'B', url: 'https://b.com/y', description: 'sb', publishedAt: '2026-10-01' },
      ]),
    )
    expect(p?.results.map((r) => r.snippet)).toEqual(['sa', 'sb'])
    expect(p?.results[1].date).toBe('2026-10-01')
  })

  it('缺 title 或 url 的条目被丢弃（无法核对的条目不该占位）', () => {
    const p = parseSearchPayload(payload([{ title: '', url: 'https://x.com' }, { title: 'ok', url: 'https://y.com' }]))
    expect(p?.results).toHaveLength(1)
    expect(p?.results[0].title).toBe('ok')
  })

  it('非搜索载荷一律返回 null（错误文本 / 坏 JSON / 空 results 缺失）', () => {
    expect(parseSearchPayload('❌ 搜索失败：网络超时')).toBeNull()
    expect(parseSearchPayload('{bad json')).toBeNull()
    expect(parseSearchPayload(JSON.stringify({ foo: 1 }))).toBeNull()
    expect(parseSearchPayload('')).toBeNull()
    expect(parseSearchPayload(undefined)).toBeNull()
  })

  it('空结果集是合法载荷（不是 null）—— 卡片要能显示"没搜到"', () => {
    const p = parseSearchPayload(payload([]))
    expect(p).not.toBeNull()
    expect(p?.results).toEqual([])
  })

  it('超长摘要被截断（卡片不能被一条摘要撑爆）', () => {
    const long = 'x'.repeat(500)
    const p = parseSearchPayload(payload([{ title: 't', url: 'https://a.com', content: long }]))
    expect(p!.results[0].snippet.length).toBeLessThanOrEqual(221)
    expect(p!.results[0].snippet.endsWith('…')).toBe(true)
  })
})
