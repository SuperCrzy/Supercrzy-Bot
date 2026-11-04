import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAccountStore } from './account'

/**
 * Regression for the 2026-11-01 flicker report.
 *
 * Symptom: with a VPN on, the app strobed between the chat and the login screen.
 * Cause: every request answered 401 (the refresh call to the account host could
 * not complete), and `reload()` treated a *failed* /api/account/status request as
 * "signed out". The router guard then bounced chat → login, the next successful
 * poll bounced back, and so on every poll.
 *
 * Invariant: a network failure must never flip the signed-in state. Only an
 * explicit answer from the backend may.
 */
describe('account store · network failure keeps the session', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('keeps signedIn when the status request throws', async () => {
    const store = useAccountStore()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ signedIn: true, email: 'a@b.c', accountId: 'acc', expiresAt: Date.now() + 60_000 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    await store.ensureReady()
    expect(store.signedIn).toBe(true)
    expect(store.degraded).toBe(false)

    // VPN drops / cross-border timeout: the fetch rejects.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await store.reload()

    expect(store.signedIn).toBe(true) // ← would have been false before the fix
    expect(store.degraded).toBe(true) // …but we do surface that it is stale
  })

  it('does sign out when the backend explicitly says so', async () => {
    const store = useAccountStore()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ signedIn: true, email: 'a@b.c', accountId: 'acc', expiresAt: Date.now() + 60_000 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    await store.ensureReady()
    expect(store.signedIn).toBe(true)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ signedIn: false, email: '', accountId: '', expiresAt: 0 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    await store.reload()

    expect(store.signedIn).toBe(false)
    expect(store.degraded).toBe(false)
  })
})
