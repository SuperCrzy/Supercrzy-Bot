import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const web = vi.hoisted(() => ({ resolveWithSignal: vi.fn(), fetchPublicWeb: vi.fn() }))
vi.mock('../services/public-web-fetch', () => web)
vi.mock('./shared', () => ({ readSetting: () => '' }))
import tool from './web-fetch'

beforeEach(() => {
  vi.clearAllMocks()
  web.resolveWithSignal.mockResolvedValue({})
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
})
afterEach(() => vi.unstubAllGlobals())

describe('web_fetch native fallback', () => {
  it('returns a decoded title and separated paragraphs without page scripts', async () => {
    web.fetchPublicWeb.mockResolvedValue({ status: 200, contentType: 'text/html; charset=utf-8', text: '<html><head><title>猫 &amp; 狗</title><style>secret-style</style></head><body><h1>说明</h1><p>第一段 &lt;例子&gt;</p><script>secret-script</script><p>第二段 &#x4e2d;</p></body></html>' })
    const result = JSON.parse(await tool.execute({ url: 'https://example.com/' }))
    expect(result.title).toBe('猫 & 狗')
    expect(result.content).toContain('说明\n\n第一段 <例子>')
    expect(result.content).toContain('第二段 中')
    expect(result.content).not.toMatch(/secret-script|secret-style/)
  })

  it('preserves angle brackets and line breaks in plain text', async () => {
    const content = 'if a < b and c > d\nsecond line'
    web.fetchPublicWeb.mockResolvedValue({ status: 200, contentType: 'text/plain', text: content })
    const result = JSON.parse(await tool.execute({ url: 'https://example.com/' }))
    expect(result.content).toBe(content)
  })

  it('reports the final URL and accepts case-insensitive content types', async () => {
    web.fetchPublicWeb.mockResolvedValue({ status: 200, contentType: 'Text/Plain; Charset=UTF-8', text: '重定向后的内容', finalUrl: 'https://example.com/article' })
    const result = JSON.parse(await tool.execute({ url: 'https://example.com/old' }))
    expect(result.url).toBe('https://example.com/article')
    expect(result.content).toBe('重定向后的内容')
  })

  it('bounds output length and uses the default for invalid requests', async () => {
    const content = 'a'.repeat(120_000)
    web.fetchPublicWeb.mockResolvedValue({ status: 200, contentType: 'text/plain', text: content })
    for (const maxLength of [-10, 0, Number.NaN, Infinity, '100']) {
      const result = JSON.parse(await tool.execute({ url: 'https://example.com/', maxLength }))
      expect(result.content).toHaveLength(8000)
      expect(result.truncated).toBe(true)
      expect(result.totalLength).toBe(content.length)
    }
    const limited = JSON.parse(await tool.execute({ url: 'https://example.com/', maxLength: 200_000 }))
    expect(limited.content).toHaveLength(100_000)
    const short = JSON.parse(await tool.execute({ url: 'https://example.com/', maxLength: 5.9 }))
    expect(short.content).toHaveLength(5)
  })

  it('cancels an oversized reader response and uses the bounded native fallback', async () => {
    const cancel = vi.fn()
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 7) controller.enqueue(new Uint8Array(1024 * 1024))
        else controller.close()
      },
      cancel,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    web.fetchPublicWeb.mockResolvedValue({ status: 200, contentType: 'text/plain', text: '回退后的网页正文' })
    const result = JSON.parse(await tool.execute({ url: 'https://example.com/' }))
    expect(result.content).toBe('回退后的网页正文')
    expect(cancel).toHaveBeenCalledOnce()
    expect(web.fetchPublicWeb).toHaveBeenCalledOnce()
  })
})
