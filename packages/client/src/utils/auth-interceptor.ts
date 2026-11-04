import type { Router } from 'vue-router'
import { useAccountStore } from '@/stores/account'

/**
 * Any 401 from the local backend means the session is probably gone (refresh
 * token rejected or aged out). Instead of assuming it, ask the account store to
 * re-check — /api/account/status is public and answers truthfully — and only
 * then route to the login screen.
 *
 * Order matters: the router guard bounces a signed-in user away from /login, so
 * the store has to learn the truth *before* the redirect or the two fight each
 * other and the user stays stuck on a dead screen.
 *
 * Account endpoints are exempt: status answers 200 by design, and login/logout
 * must work while signed out.
 */
export function installAuthInterceptor(router: Router): void {
  const original = window.fetch.bind(window)
  let recovering = false
  // Loop breaker: when the IdP is unreachable, several parallel requests answer
  // 401 within the same tick. Each one would call router.replace('Login'); the
  // guard bounces a still-signed-in user straight back, which reads as a
  // strobing screen. One redirect per burst is enough.
  let lastRedirectAt = 0

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await original(input, init)
    if (res.status === 401 && !recovering) {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      if (url.includes('/api/') && !url.includes('/api/account/')) {
        recovering = true
        try {
          const account = useAccountStore()
          await account.reload()
          const quiet = Date.now() - lastRedirectAt < 3000
          if (!account.signedIn && !quiet && router.currentRoute.value.name !== 'Login') {
            lastRedirectAt = Date.now()
            void router.replace({ name: 'Login' })
          }
        } finally {
          recovering = false
        }
      }
    }
    return res
  }
}

