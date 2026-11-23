import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAccountStore } from './account'

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.unstubAllGlobals())

describe('account encryption state', () => {
  it('exposes local account storage failure and clears it after recovery', async () => {
    let broken = true
    vi.stubGlobal('fetch', vi.fn(async () => broken
      ? new Response(JSON.stringify({ error: 'account_storage_unavailable' }), { status: 503 })
      : new Response(JSON.stringify({ signedIn: false, accountId: '', email: '', expiresAt: 0 }))))
    const store = useAccountStore()
    await store.ensureReady()
    expect(store.storageError).toBe(true)
    expect(store.signedIn).toBe(false)
    broken = false
    await store.reload()
    expect(store.storageError).toBe(false)
    expect(store.degraded).toBe(false)
  })
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

  it('ignores an older status response after a newer account response', async () => {
    let finishOld!: (value: Response) => void
    let statusCount = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      statusCount++
      if (statusCount === 1) return Promise.resolve(new Response(JSON.stringify({ signedIn: true, accountId: 'account-a' })))
      if (statusCount === 2) return new Promise<Response>((resolve) => { finishOld = resolve })
      return Promise.resolve(new Response(JSON.stringify({ signedIn: true, accountId: 'account-b' })))
    }))
    const store = useAccountStore()
    await store.ensureReady()
    const old = store.reload()
    await store.reload()
    finishOld(new Response(JSON.stringify({ signedIn: true, accountId: 'account-a' })))
    await old
    expect(store.accountId).toBe('account-b')
  })

  it('ignores stale status and does not poll while logout is pending', async () => {
    let finishStatus!: (value: Response) => void
    let finishLogout!: (value: Response) => void
    let statusCount = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/account/logout') return new Promise<Response>((resolve) => { finishLogout = resolve })
      statusCount++
      if (statusCount === 1) return Promise.resolve(new Response(JSON.stringify({ signedIn: true, accountId: 'account-a' })))
      return new Promise<Response>((resolve) => { finishStatus = resolve })
    }))
    const store = useAccountStore()
    await store.ensureReady()
    const old = store.reload()
    const logout = store.signOut()
    await store.reload()
    expect(statusCount).toBe(2)
    finishStatus(new Response(JSON.stringify({ signedIn: true, accountId: 'account-a' })))
    await old
    expect(store.signedIn).toBe(false)
    finishLogout(new Response('{}'))
    await logout
    expect(store.accountId).toBe('')
  })

  it('reports an unconfirmed logout while clearing in-memory encryption keys', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/account/status'
      ? new Response(JSON.stringify({ signedIn: true, accountId: 'account-a' }))
      : new Response('', { status: 503 })))
    const store = useAccountStore()
    await store.ensureReady()
    store.unlockedDek = {} as CryptoKey
    await expect(store.signOut()).rejects.toThrow('logout_unconfirmed')
    expect(store.signedIn).toBe(false)
    expect(store.unlockedDek).toBeNull()
    expect(store.degraded).toBe(true)
  })
})
