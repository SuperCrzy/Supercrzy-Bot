/**
 * A rejected refresh must not delete the user's session.
 *
 * Observed failure: the account service answered `401 {"error":{"code":"reuse"}}`.
 * The client treated every 4xx as "signed out" and removed the session file, so a
 * token that another process had already rotated looked like a logout and there was
 * no recovery short of signing in again. `reuse` describes the attempt, not the user.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
let prevDir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sc-refresh-'))
  prevDir = process.env.SC_AUTH_DIR
  process.env.SC_AUTH_DIR = dir
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (prevDir === undefined) delete process.env.SC_AUTH_DIR
  else process.env.SC_AUTH_DIR = prevDir
  rmSync(dir, { recursive: true, force: true })
})

/** Seed a signed-in session that needs a refresh (access token already expired). */
async function seedExpiredSession() {
  const store = await import('./account-store')
  store.writeSession({
    accountId: 'acc-1',
    email: 'a@b.c',
    deviceId: 'dev-1',
    accessToken: 'old',
    refreshToken: 'rt-old',
    expiresAt: Date.now() - 60_000,
    savedAt: Date.now(),
  } as never)

  // The stored blob needs a device id and refresh token to attempt a rotation.
  return store
}

describe('refresh rejection handling', () => {
  it('keeps the session when the server reports a reuse race', async () => {
    const store = await seedExpiredSession()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'reuse', message: 'Refresh rejected' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )))

    const auth = await import('./account-auth')
    const token = await auth.ensureAccessToken()

    // No token, but the session file survives — the next attempt can still use it.
    expect(token).toBeNull()
    expect(existsSync(join(dir, 'auth.json'))).toBe(true)
    expect(store.readSession()?.accountId).toBe('acc-1')
    // And the caller is told "could not confirm", not "signed out".
    expect(auth.refreshOutcome()).toBe('unreachable')
  })

  it('keeps the session on a plain 4xx too, but reports invalid', async () => {
    await seedExpiredSession()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'revoked' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )))

    const auth = await import('./account-auth')
    expect(await auth.ensureAccessToken()).toBeNull()
    // Marked invalid so the UI can prompt, but nothing was deleted behind the user's back.
    expect(auth.refreshOutcome()).toBe('invalid')
    expect(existsSync(join(dir, 'auth.json'))).toBe(true)
  })

  it('reports unreachable and keeps the session when the network fails', async () => {
    await seedExpiredSession()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))

    const auth = await import('./account-auth')
    expect(await auth.ensureAccessToken()).toBeNull()
    expect(auth.refreshOutcome()).toBe('unreachable')
    expect(existsSync(join(dir, 'auth.json'))).toBe(true)
  })

  it('rotates normally when the server accepts the token', async () => {
    const store = await seedExpiredSession()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ accessToken: 'new-token', refreshToken: 'rt-new', expiresIn: 900 }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))

    const auth = await import('./account-auth')
    expect(await auth.ensureAccessToken()).toBe('new-token')
    expect(auth.refreshOutcome()).toBe('ok')
    expect(store.readSession()?.refreshToken).toBe('rt-new')
  })
})
