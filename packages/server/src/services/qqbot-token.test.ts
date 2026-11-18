import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureToken } from './qqbot-client'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('QQ token cache', () => {
  it('separates bots and rotated secrets', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { appId, clientSecret } = JSON.parse(String(init?.body))
      return Response.json({ access_token: `${appId}:${clientSecret}`, expires_in: 7200 })
    }))
    const a = { appId: 'token-test-a', appSecret: 'old', intents: 0 }
    expect(await ensureToken(a)).toBe('token-test-a:old')
    expect(await ensureToken({ ...a, appId: 'token-test-b' })).toBe('token-test-b:old')
    expect(await ensureToken({ ...a, appSecret: 'new' })).toBe('token-test-a:new')
    expect(await ensureToken(a)).toBe('token-test-a:old')
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('shares an in-flight request for the same credentials', async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })))
    const cfg = { appId: 'token-test-inflight', appSecret: 'x', intents: 0 }
    const first = ensureToken(cfg)
    const second = ensureToken(cfg)
    expect(fetch).toHaveBeenCalledTimes(1)
    finish(Response.json({ access_token: 'same-token', expires_in: 7200 }))
    expect(await Promise.all([first, second])).toEqual(['same-token', 'same-token'])
  })
  it('does not cache invalid expiry data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'bad', expires_in: -1 })))
    const cfg = { appId: 'token-test-bad', appSecret: 'x', intents: 0 }
    await expect(ensureToken(cfg)).rejects.toThrow('invalid expires_in')
    await expect(ensureToken(cfg)).rejects.toThrow('invalid expires_in')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
