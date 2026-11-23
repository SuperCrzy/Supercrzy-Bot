import { defineStore } from 'pinia'
import { ref } from 'vue'

interface AccountStatus {
  signedIn: boolean
  email: string
  accountId: string
  expiresAt: number
}

/**
 * Who is signed in on this machine.
 *
 * The desktop app cannot be used without an account, so the router guard awaits
 * `ensureReady()` before rendering anything: a returning user goes straight to
 * the app with no login flash, and a first-time user goes straight to /login.
 */
export const useAccountStore = defineStore('account', () => {
  const signedIn = ref(false)
  const email = ref('')
  const accountId = ref('')
  const expiresAt = ref(0)
  const ready = ref(false)
  /** Last status request failed: signed-in state is stale, not absent. */
  const degraded = ref(false)
  const storageError = ref(false)

  let bootPromise: Promise<void> | null = null
  let accountEpoch = 0
  let statusRequestId = 0
  let logoutPending = false

  async function fetchStatus(): Promise<AccountStatus | { storageError: true } | null> {
    try {
      const res = await fetch('/api/account/status')
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null
        return body?.error === 'account_storage_unavailable' ? { storageError: true } : null
      }
      return (await res.json()) as AccountStatus
    } catch {
      return null
    }
  }

  function apply(status: AccountStatus | null): void {
    const nextAccountId = status?.signedIn ? status.accountId : ''
    if (accountId.value !== nextAccountId) {
      accountEpoch++
      e2eEnvelope.value = null
      e2eStatus.value = 'idle'
      e2eRequestId++
      unlockedDek.value = null
      e2eUnlocked.value = false
      lastSyncVersion.value = 0
    }
    signedIn.value = !!status?.signedIn
    email.value = status?.email || ''
    accountId.value = status?.accountId || ''
    expiresAt.value = status?.expiresAt || 0
  }

  /** Runs once per boot. Repeated calls share the first request. */
  function ensureReady(): Promise<void> {
    if (ready.value) return Promise.resolve()
    if (!bootPromise) {
      const requestId = ++statusRequestId
      bootPromise = fetchStatus().then((status) => {
        if (requestId === statusRequestId && !logoutPending) {
          if (status && 'storageError' in status) { storageError.value = true; degraded.value = true }
          else if (status) { storageError.value = false; apply(status) }
          else degraded.value = true
        }
        ready.value = true
      })
    }
    return bootPromise
  }

  async function reload(): Promise<void> {
    if (logoutPending) return
    const requestId = ++statusRequestId
    const status = await fetchStatus()
    if (requestId !== statusRequestId || logoutPending) return
    // 🔴 2026-11-01: a *failed* status request is not a sign-out.
    // Applying null here flipped `signedIn` to false whenever the account host
    // was unreachable (VPN / cross-border hiccup) while every API answered 401,
    // and the router guard then bounced chat ↔ login every poll: the reported
    // flicker. Keep the last known state; only a real answer may change it.
    if (status && 'storageError' in status) { storageError.value = true; degraded.value = true; return }
    if (status) { storageError.value = false; apply(status) }
    degraded.value = !status
  }

  /**
   * Ask the backend to start a login. The backend opens the system browser and
   * returns the same URL, which the login screen offers as a fallback link when
   * the browser refuses to open.
   */
  async function startLogin(): Promise<string> {
    const res = await fetch('/api/account/login/start', { method: 'POST' })
    if (!res.ok) throw new Error(`login start failed: ${res.status}`)
    const data = (await res.json()) as { url?: string }
    if (!data.url) throw new Error('login start returned no url')
    return data.url
  }

  async function signOut(): Promise<void> {
    if (logoutPending) return
    logoutPending = true
    statusRequestId++
    apply(null)
    try {
      const response = await fetch('/api/account/logout', { method: 'POST', signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw new Error('logout_unconfirmed')
    } catch {
      degraded.value = true
      throw new Error('logout_unconfirmed')
    } finally {
      logoutPending = false
    }
  }

  // ---- M8 P2: E2E envelope + session sync state ----
  /** Envelope metadata from the IdP (null = E2E not set up yet). */
  const e2eEnvelope = ref<{ kdf: string; salt: string; wrappedDek: string; version: number } | null>(null)
  const e2eStatus = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  let e2eRequestId = 0
  /** DEK lives in memory only after unlock; never persisted. */
  const unlockedDek = ref<CryptoKey | null>(null)
  const e2eUnlocked = ref(false)
  const lastSyncVersion = ref(0)
  const syncing = ref(false)

  async function refreshE2eEnvelope(): Promise<void> {
    const owner = accountId.value
    const epoch = accountEpoch
    if (!owner) return
    const requestId = ++e2eRequestId
    e2eStatus.value = 'loading'
    try {
      const res = await fetch('/api/account/e2e', { headers: { 'X-Supercrzy-Account': owner } })
      if (!res.ok) throw new Error('envelope_unavailable')
      const body = (await res.json()) as { envelope: { kdf: string; salt: string; wrappedDek: string; version: number } | null }
      if (!body || !Object.prototype.hasOwnProperty.call(body, 'envelope')) throw new Error('invalid_envelope_response')
      if (accountEpoch === epoch && accountId.value === owner && requestId === e2eRequestId) {
        e2eEnvelope.value = body.envelope ?? null
        e2eStatus.value = 'ready'
      }
    } catch {
      if (accountEpoch === epoch && accountId.value === owner && requestId === e2eRequestId) e2eStatus.value = 'error'
    }
  }

  /** First-time setup: create the envelope from a passphrase (12+ chars). */
  async function setupE2e(passphrase: string): Promise<void> {
    const owner = accountId.value
    const epoch = accountEpoch
    if (!owner) throw new Error('not_signed_in')
    if (e2eStatus.value !== 'ready' || e2eEnvelope.value) throw new Error('envelope_not_ready')
    const { createEnvelope } = await import('@/services/e2e-crypto')
    const { envelope, unlocked } = await createEnvelope(passphrase)
    if (accountEpoch !== epoch) throw new Error('account_changed')
    await new E2eApiBridge().putEnvelope(envelope, owner)
    if (accountEpoch !== epoch) throw new Error('account_changed')
    e2eEnvelope.value = envelope
    unlockedDek.value = unlocked.dek
    e2eUnlocked.value = true
  }

  /** Unlock with the passphrase on this device (decrypts wrappedDek). */
  async function unlockE2e(passphrase: string): Promise<void> {
    const epoch = accountEpoch
    if (!e2eEnvelope.value) throw new Error('no_envelope')
    const { unlockEnvelope } = await import('@/services/e2e-crypto')
    const { dek } = await unlockEnvelope(passphrase, e2eEnvelope.value)
    if (accountEpoch !== epoch) throw new Error('account_changed')
    unlockedDek.value = dek
    e2eUnlocked.value = true
  }

  /** Push all local sessions (manual trigger or post-unlock bootstrap). */
  async function syncNow(): Promise<{ sessions: number; items: number; failures: string[] }> {
    const dek = unlockedDek.value
    const owner = accountId.value
    const epoch = accountEpoch
    if (!dek || !owner) throw new Error('e2e_locked')
    if (syncing.value) throw new Error('sync_in_progress')
    syncing.value = true
    try {
    const { encryptBlob, decryptBlob } = await import('@/services/e2e-crypto')
    const { pushAllSessions } = await import('@/services/session-sync')
      if (accountEpoch !== epoch) throw new Error('account_changed')
      const r = await pushAllSessions(dek, { encryptBlob, decryptBlob }, owner)
      if (accountEpoch !== epoch) throw new Error('account_changed')
      const status = await fetch('/api/auth-sync/status', { headers: { 'X-Supercrzy-Account': owner } })
      if (status.ok) {
        const body = (await status.json()) as { latestVersion?: number }
        if (accountEpoch === epoch) lastSyncVersion.value = body.latestVersion ?? 0
      }
      return r
    } finally {
      syncing.value = false
    }
  }

  async function restoreSessions(): Promise<{ imported: number; skipped: number; failures: string[] }> {
    const dek = unlockedDek.value
    const owner = accountId.value
    const epoch = accountEpoch
    if (!dek || !owner) throw new Error('e2e_locked')
    if (syncing.value) throw new Error('sync_in_progress')
    syncing.value = true
    try {
      const { decryptBlob } = await import('@/services/e2e-crypto')
      const { importNewSessions } = await import('@/services/session-sync')
      if (accountEpoch !== epoch) throw new Error('account_changed')
      const result = await importNewSessions(dek, { decryptBlob }, owner)
      if (accountEpoch !== epoch) throw new Error('account_changed')
      return result
    } finally { syncing.value = false }
  }

  /** Minimal passthrough helper (avoids a circular import with E2eApi). */
  class E2eApiBridge {
    async putEnvelope(envelope: Record<string, unknown>, owner: string): Promise<void> {
      const res = await fetch('/api/account/e2e', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Supercrzy-Account': owner },
        body: JSON.stringify(envelope),
      })
      if (!res.ok) throw new Error(`e2e PUT ${res.status}`)
    }
  }

  return {
    e2eEnvelope, e2eStatus, unlockedDek, e2eUnlocked, lastSyncVersion, syncing,
    refreshE2eEnvelope, setupE2e, unlockE2e, syncNow, restoreSessions, signedIn, email, accountId, expiresAt, ready, degraded, storageError, ensureReady, reload, startLogin, signOut }
})
