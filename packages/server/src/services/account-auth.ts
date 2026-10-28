/**
 * The desktop app requires a signed-in account, so every API call behind this
 * gate needs a usable access token. Two things happen here:
 *
 *   1. If the stored access token is still fresh, requests pass straight through.
 *   2. If it has expired, the refresh token is used to rotate it — once, shared
 *      by every concurrent request, so a burst of calls cannot stampede the
 *      auth service and trip its reuse detection.
 *
 * This is a product gate, not a security boundary: the bundled client is on the
 * user's machine and can be modified. What actually protects cloud resources is
 * the signature check on whichever service consumes the token.
 */
import type { Context, Next } from 'koa'
import { readSession, writeSession, clearSession, currentAccessToken, isSignedIn } from './account-store'

/** Reachable without an account — the sign-in flow itself, plus health. */
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/account/status',
  '/api/account/login/start',
  '/api/account/logout',
])

/**
 * `<audio src>` cannot carry an Authorization header, so these authenticate with
 * a one-time URL token instead (see routes/tts.ts). Gating them here would break
 * speech playback without adding any protection.
 */
const HEADERLESS_PATHS = new Set(['/api/tts/stream', '/api/tts/live/stream'])

/** Refresh a little early so a request is never sent with a token about to die. */
const EXPIRY_MARGIN_MS = 60 * 1000

function authOrigin(): string {
  return (process.env.SUPERCRZY_AUTH_ORIGIN || 'https://auth.supercrzy.com').replace(/\/$/, '')
}

let inFlightRefresh: Promise<boolean> | null = null

async function rotate(): Promise<boolean> {
  const session = readSession()
  if (!session?.refreshToken || !session.deviceId) return false

  let res: Response
  try {
    res = await fetch(authOrigin() + '/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken, deviceId: session.deviceId }),
    })
  } catch {
    // Offline: keep the session on disk. The user stays "signed in" and the next
    // request retries; wiping it here would log people out on a flaky network.
    return false
  }

  if (res.status === 409) {
    // Another process already rotated this token; the newest one is on disk.
    const latest = readSession()
    if (latest && latest.refreshToken !== session.refreshToken) {
      return !!currentAccessToken()
    }
    return false
  }
  if (!res.ok) {
    // The auth service rejected the refresh token outright. Keep the user signed
    // out locally so the UI and the gate agree instead of looping.
    if (res.status >= 400 && res.status < 500) clearSession()
    return false
  }

  const data = (await res.json().catch(() => null)) as
    | { accessToken?: string; refreshToken?: string; expiresIn?: number }
    | null
  if (!data?.accessToken) return false

  writeSession({
    ...session,
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || session.refreshToken,
    expiresAt: Date.now() + (data.expiresIn ?? 900) * 1000,
    // Slide the offline window: this is the last time we reached the server.
    savedAt: Date.now(),
  })
  return true
}

/** A usable access token, rotating it first if needed. Null means "sign in". */
export async function ensureAccessToken(now = Date.now()): Promise<string | null> {
  const session = readSession()
  if (!session) return null
  if (session.accessToken && session.expiresAt - now > EXPIRY_MARGIN_MS) return session.accessToken

  if (!inFlightRefresh) {
    inFlightRefresh = rotate().finally(() => {
      inFlightRefresh = null
    })
  }
  const ok = await inFlightRefresh
  return ok ? currentAccessToken() : null
}

export async function requireAccount(ctx: Context, next: Next): Promise<void> {
  const path = ctx.path
  if (!path.startsWith('/api/') || PUBLIC_PATHS.has(path) || HEADERLESS_PATHS.has(path)) {
    return next()
  }

  const token = await ensureAccessToken()
  if (!token) {
    ctx.status = 401
    ctx.body = { error: 'sign_in_required', message: 'Sign in to use SUPERCRZY BOT' }
    return
  }
  return next()
}

/** Re-exported so the app can decide whether to show the login screen at boot. */
export { isSignedIn }
