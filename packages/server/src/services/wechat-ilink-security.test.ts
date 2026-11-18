import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadFile, getUpdates, sendMediaFileToWeChat, sendMessage } from './wechat-ilink'
import { wechatMessageId } from './channel-message-dedup'
import { createCipheriv } from 'node:crypto'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('WeChat media credential boundaries', () => {
  it('preserves distinct uint64 message IDs without changing text content', async () => {
    const json = '{"ret":0,"get_updates_buf":"next","msgs":[{"message_id":9007199254740992,"client_id":"same","content":"literal \\\"message_id\\\":123"},{"message_id":9007199254740993,"client_id":"same"}]}'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(json)))
    const result = await getUpdates('https://example.invalid', 'token', '')
    expect(wechatMessageId(result.msgs![0])).toBe('message_id:9007199254740992')
    expect(wechatMessageId(result.msgs![1])).toBe('message_id:9007199254740993')
    expect((result.msgs![0] as any).content).toBe('literal "message_id":123')
  })
  it.each([{ ret: -1 }, { ret: 0, errcode: -14 }])('reports an iLink business error instead of false success', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
    await expect(sendMessage('https://example.invalid', 'token', 'user', 'hello', 'context')).rejects.toThrow('ilink_request_rejected')
  })
  it.each(['http://127.0.0.1:3000/private', 'https://attacker.example/media', 'file:///etc/passwd'])('does not fetch model-provided media URLs: %s', async (url) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const result = await sendMediaFileToWeChat({ token: 'token', baseUrl: 'https://example.invalid', accountId: 'a', userId: 'u', savedAt: 0 }, 'u', 'context', url)
    expect(result).toEqual({ success: false, error: 'remote_media_not_supported' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([
    'https://attacker.example/file',
    'http://novac2c.cdn.weixin.qq.com/file',
    'https://novac2c.cdn.weixin.qq.com.attacker.example/file',
    'https://user:password@novac2c.cdn.weixin.qq.com/file',
    'http://127.0.0.1:3000/file',
  ])('never sends the bearer token to an untrusted URL: %s', async (url) => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await downloadFile('private-token', { type: 3, file_item: { file_name: 'test.txt', file_size: 0, cdn_url: url, cdn_aes_key: 'invalid-key' } })
    expect(result).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refuses redirects and does not log the CDN URL or invalid key', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array(16)))
    vi.stubGlobal('fetch', fetcher)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const url = 'https://novac2c.cdn.weixin.qq.com/file?private=fixture-url-secret'
    await downloadFile('private-token', { type: 3, file_item: { file_name: 'test.txt', file_size: 0, cdn_url: url, cdn_aes_key: 'private-invalid-key' } })
    expect(fetcher).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error' }))
    const logs = JSON.stringify([...log.mock.calls, ...error.mock.calls])
    expect(logs).not.toContain('fixture-url-secret')
    expect(logs).not.toContain('private-invalid-key')
    expect(logs).not.toContain('private-token')
  })
  it('decrypts a valid bounded response', async () => {
    const key = Buffer.alloc(16, 7)
    const cipher = createCipheriv('aes-128-ecb', key, null)
    const encrypted = Buffer.concat([cipher.update('hello'), cipher.final()])
    vi.stubGlobal('fetch', vi.fn(async () => new Response(encrypted)))
    const result = await downloadFile('token', { type: 4, file_item: { file_name: 'test.txt', file_size: 5, cdn_url: 'https://novac2c.cdn.weixin.qq.com/file', cdn_aes_key: key.toString('base64') } })
    expect(result?.textContent).toBe('hello')
  })
  it('cancels a response that exceeds the limit even without content-length', async () => {
    let cancelled = false
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { if (sent++ < 22) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close() },
      cancel() { cancelled = true },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await downloadFile('token', { type: 4, file_item: { file_name: 'big', file_size: 0, cdn_url: 'https://novac2c.cdn.weixin.qq.com/file', cdn_aes_key: 'invalid' } })
    expect(result).toBeNull()
    expect(cancelled).toBe(true)
  })
})
