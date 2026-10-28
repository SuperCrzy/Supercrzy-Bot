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

  let bootPromise: Promise<void> | null = null

  async function fetchStatus(): Promise<AccountStatus | null> {
    try {
      const res = await fetch('/api/account/status')
      if (!res.ok) return null
      return (await res.json()) as AccountStatus
    } catch {
      return null
    }
  }

  function apply(status: AccountStatus | null): void {
    signedIn.value = !!status?.signedIn
    email.value = status?.email || ''
    accountId.value = status?.accountId || ''
    expiresAt.value = status?.expiresAt || 0
  }

  /** Runs once per boot. Repeated calls share the first request. */
  function ensureReady(): Promise<void> {
    if (ready.value) return Promise.resolve()
    if (!bootPromise) {
      bootPromise = fetchStatus().then((status) => {
        apply(status)
        ready.value = true
      })
    }
    return bootPromise
  }

  async function reload(): Promise<void> {
    apply(await fetchStatus())
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
    try {
      await fetch('/api/account/logout', { method: 'POST' })
    } catch {
      /* offline sign-out still clears local state below */
    }
    apply(null)
  }

  return { signedIn, email, accountId, expiresAt, ready, ensureReady, reload, startLogin, signOut }
})
