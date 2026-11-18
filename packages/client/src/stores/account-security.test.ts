import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAccountStore } from './account'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.unstubAllGlobals())

describe('account encryption state', () => {
  it('distinguishes an unavailable envelope from an account without encryption', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/account/status') return new Response(JSON.stringify({ signedIn: true, accountId: 'account-a', email: '', expiresAt: 1 }))
      return fail ? new Response('', { status: 503 }) : new Response(JSON.stringify({ envelope: null }))
    }))
    const store = useAccountStore()
    await store.ensureReady()
    await store.refreshE2eEnvelope()
    expect(store.e2eStatus).toBe('error')
    await expect(store.setupE2e('correct horse battery staple')).rejects.toThrow('envelope_not_ready')
    fail = false
    await store.refreshE2eEnvelope()
    expect(store.e2eStatus).toBe('ready')
    expect(store.e2eEnvelope).toBeNull()
  })
  it('clears the old account key when status changes and ignores stale envelope responses', async () => {
    let account = 'account-a'
    let finishEnvelope!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/account/status') return Promise.resolve(new Response(JSON.stringify({ signedIn: true, accountId: account, email: '', expiresAt: 1 })))
      return new Promise<Response>((resolve) => { finishEnvelope = resolve })
    }))
    const store = useAccountStore()
    await store.ensureReady()
    store.unlockedDek = {} as CryptoKey
    store.e2eUnlocked = true
    store.lastSyncVersion = 9
    const oldRequest = store.refreshE2eEnvelope()
    account = 'account-b'
    await store.reload()
    finishEnvelope(new Response(JSON.stringify({ envelope: { kdf: 'old', salt: 'old', wrappedDek: 'old', version: 1 } })))
    await oldRequest
    expect(store.accountId).toBe('account-b')
    expect(store.unlockedDek).toBeNull()
    expect(store.e2eUnlocked).toBe(false)
    expect(store.e2eEnvelope).toBeNull()
    expect(store.lastSyncVersion).toBe(0)
  })

  it('clears encryption material immediately while logout is pending', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input) === '/api/account/status'
      ? Promise.resolve(new Response(JSON.stringify({ signedIn: true, accountId: 'account-a', email: '', expiresAt: 1 })))
      : new Promise<Response>(() => {})))
    const store = useAccountStore()
    await store.ensureReady()
    store.unlockedDek = {} as CryptoKey
    store.e2eUnlocked = true
    void store.signOut()
    expect(store.signedIn).toBe(false)
    expect(store.unlockedDek).toBeNull()
    expect(store.e2eUnlocked).toBe(false)
  })
})
