import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dns = vi.hoisted(() => ({
  lookup: vi.fn(), resolve4: vi.fn(), resolve6: vi.fn(), setServers: vi.fn(),
}))
vi.mock('node:dns/promises', () => ({
  lookup: dns.lookup,
  Resolver: class {
    setServers = dns.setServers
    resolve4 = dns.resolve4
    resolve6 = dns.resolve6
  },
}))
vi.mock('./shared', () => ({ readSetting: () => '' }))
import tool from './web-fetch'

beforeEach(() => {
  vi.clearAllMocks()
  dns.lookup.mockResolvedValue([{ address: '198.18.0.42', family: 4 }])
  dns.resolve4.mockResolvedValue(['8.8.8.8'])
  dns.resolve6.mockRejectedValue(Object.assign(new Error('no data'), { code: 'ENODATA' }))
})
afterEach(() => vi.unstubAllGlobals())

describe('web_fetch with a fake-IP system resolver', () => {
  it('validates via independent DNS and returns the reader response', async () => {
    const fetcher = vi.fn(async () => new Response('Title: 测试文章\nURL Source: https://example.com/\nMarkdown Content:\n网页正文足够长，能够通过最低内容长度检查。'))
    vi.stubGlobal('fetch', fetcher)
    const result = JSON.parse(await tool.execute({ url: 'https://example.com/' }))
    expect(result).toMatchObject({ ok: true, title: '测试文章', url: 'https://example.com/', content: '网页正文足够长，能够通过最低内容长度检查。' })
    expect(dns.resolve4).toHaveBeenCalledWith('example.com')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('preserves plain Markdown when the reader has no metadata envelope', async () => {
    const body = '# 页面标题\n第一段正文，不应该被当作元数据丢失。\n第二段正文。'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const result = JSON.parse(await tool.execute({ url: 'https://example.com/' }))
    expect(result.content).toBe(body)
  })

  it('preserves text on the same line as the content marker', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Title: 标题\nMarkdown Content: 第一行正文内容足够长，不应被忽略。\n\n第二行正文。')))
    const result = JSON.parse(await tool.execute({ url: 'https://example.com/' }))
    expect(result.content).toBe('第一行正文内容足够长，不应被忽略。\n\n第二行正文。')
  })

  it('finds a content marker after more than twelve metadata lines', async () => {
    const header = ['Title: 标题', ...Array.from({ length: 20 }, (_, i) => `Extra-${i}: value`), 'Markdown Content:'].join('\n')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`${header}\n这是较长头部之后的完整文章正文。`)))
    const result = JSON.parse(await tool.execute({ url: 'https://example.com/' }))
    expect(result.title).toBe('标题')
    expect(result.content).toBe('这是较长头部之后的完整文章正文。')
  })

  it('does not mistake a marker within plain Markdown for an envelope', async () => {
    const body = '# 文档\n这里是开头，不应该丢失。\nMarkdown Content: 这是文章里的一行。'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    const result = JSON.parse(await tool.execute({ url: 'https://example.com/' }))
    expect(result.content).toBe(body)
  })

  it('never contacts the reader when independent DNS resolves to a private address', async () => {
    dns.resolve4.mockResolvedValue(['127.0.0.1'])
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(await tool.execute({ url: 'https://example.com/' })).toContain('安全策略拒绝')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('explains when independent DNS cannot verify a fake-IP domain', async () => {
    dns.resolve4.mockRejectedValue(Object.assign(new Error('timed out'), { code: 'ETIMEOUT' }))
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    expect(await tool.execute({ url: 'https://example.com/' })).toContain('无法通过独立 DNS 验证')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
