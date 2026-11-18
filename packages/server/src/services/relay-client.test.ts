import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  accountId: 'account-a',
  signedIn: true,
  sockets: [] as Array<{ url: string; close: () => void; readyState: number }>,
}))

vi.mock('./database', () => ({
  getDB: () => ({ prepare: (sql: string) => ({
    get: (key: string) => state.settings.has(key) ? { value: state.settings.get(key) } : undefined,
    run: (key: string, value: string) => { if (sql.includes('settings')) state.settings.set(key, value) },
  }) }),
}))
vi.mock('./account-store', () => ({
  isSignedIn: () => state.signedIn,
  readSession: () => state.signedIn ? { accountId: state.accountId, accessToken: 'test-access' } : null,
}))
vi.mock('./account-auth', () => ({ ensureAccessToken: async () => 'test-access' }))
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1
    readyState = 1
    constructor(public url: string) { super(); state.sockets.push(this) }
    close() { this.emit('close') }
    send() {}
  }
  return { default: FakeWebSocket }
})

import { startRelayClient, stopRelayClient } from './relay-client'

beforeEach(() => {
  state.settings.clear()
  state.sockets.length = 0
  state.accountId = 'account-a'
  state.signedIn = true
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ channel: 'workspace-a', connectionToken: 'test-token', expiresAt: Date.now() + 300_000 }))))
})

afterEach(() => { stopRelayClient(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('relay account lifecycle', () => {
  it('registers once, caches the owner, and does not open duplicate sockets on repeated starts', async () => {
    startRelayClient()
    startRelayClient()
    await vi.waitFor(() => expect(state.sockets).toHaveLength(1))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(state.settings.get('workspaceAccountId')).toBe('account-a')
    expect(state.sockets[0].url).toContain('channel=workspace-a')
  })

  it('does not reconnect using a previous account\'s cached credentials', async () => {
    state.settings.set('workspaceAccountId', 'previous-account')
    state.settings.set('workspaceAuthOrigin', 'https://auth.supercrzy.com')
    state.settings.set('workspaceChannel', 'old-channel')
    state.settings.set('workspaceConnectionToken', 'old-token')
    state.settings.set('workspaceRelayUrl', 'wss://relay.example')
    startRelayClient()
    await vi.waitFor(() => expect(state.sockets).toHaveLength(1))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(state.sockets[0].url).not.toContain('old-channel')
  })

  it('does not connect or cache credentials if stopped while registration is pending', async () => {
    let resolveResponse!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve })))
    startRelayClient()
    await vi.waitFor(() => expect(resolveResponse).toBeTypeOf('function'))
    stopRelayClient()
    resolveResponse(new Response(JSON.stringify({ channel: 'late-channel', connectionToken: 'late-token', expiresAt: Date.now() + 300_000 })))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(state.sockets).toHaveLength(0)
    expect(state.settings.get('workspaceChannel')).toBeUndefined()
  })

  it('refreshes credentials before the existing workspace connection expires', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ channel: 'workspace-a', connectionToken: 'short-lived', expiresAt: Date.now() + 31_000 }))))
    startRelayClient()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2200)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(state.sockets).toHaveLength(2)
  })
})
