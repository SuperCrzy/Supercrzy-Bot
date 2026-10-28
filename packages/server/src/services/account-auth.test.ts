import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context, Next } from 'koa'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSession, writeSession, type StoredSession } from './account-store'
import { ensureAccessToken, requireAccount } from './account-auth'

let dir: string
const realFetch = globalThis.fetch

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  const now = Date.now()
  return {
    accountId: 'acc-1',
    email: 'reader@example.com',
    deviceId: 'dev-1',
    accessToken: 'access-old',
    refreshToken: 'refresh-1',
    expiresAt: now + 10 * 60 * 1000,
    savedAt: now,
    ...overrides,
  }
}

function ctx(path: string): Context {
  return { path, status: 200, body: undefined } as unknown as Context
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sc-auth-test-'))
  process.env.SC_AUTH_DIR = dir
  process.env.SUPERCRZY_AUTH_ORIGIN = 'http://auth.test'
})

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.fetch = realFetch
  rmSync(dir, { recursive: true, force: true })
  delete process.env.SC_AUTH_DIR
})

describe('signed-in gate', () => {
  it('rejects API calls when there is no session', async () => {
    const c = ctx('/api/chat/agent')
    const next = vi.fn()
    await requireAccount(c, next as unknown as Next)
    expect(c.status).toBe(401)
    expect(c.body).toMatchObject({ error: 'sign_in_required' })
    expect(next).not.toHaveBeenCalled()
  })

  it('lets a fresh access token through without touching the network', async () => {
    writeSession(session())
    const spy = vi.fn(() => {
      throw new Error('must not call the auth service')
    })
    vi.stubGlobal('fetch', spy)
    const c = ctx('/api/chat/agent')
    const next = vi.fn(async () => {})
    await requireAccount(c, next as unknown as Next)
    expect(next).toHaveBeenCalled()
    expect(c.status).toBe(200)
    expect(spy).not.toHaveBeenCalled()
  })

  it('exempts the sign-in endpoints and non-API paths', async () => {
    for (const path of ['/api/health', '/api/account/status', '/api/account/login/start', '/api/tts/stream', '/login']) {
      const c = ctx(path)
      const next = vi.fn(async () => {})
      await requireAccount(c, next as unknown as Next)
      expect(c.status).toBe(200)
      expect(next).toHaveBeenCalled()
    }
  })
})

describe('silent rotation', () => {
  it('rotates an expired access token and keeps the session', async () => {
    writeSession(session({ expiresAt: Date.now() - 1000 }))
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return new Response(JSON.stringify({ accessToken: 'access-new', refreshToken: 'refresh-2', expiresIn: 900 }), { status: 200 })
    })

    const token = await ensureAccessToken()
    expect(token).toBe('access-new')
    expect(calls).toBe(1)
    const stored = readSession()
    expect(stored?.accessToken).toBe('access-new')
    expect(stored?.refreshToken).toBe('refresh-2')
    // The offline window slides forward on every successful rotation.
    expect(stored!.savedAt).toBeGreaterThan(Date.now() - 5000)
  })

  it('collapses concurrent requests into a single rotation', async () => {
    writeSession(session({ expiresAt: Date.now() - 1000 }))
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      await new Promise((r) => setTimeout(r, 30))
      return new Response(JSON.stringify({ accessToken: 'access-new', refreshToken: 'refresh-2', expiresIn: 900 }), { status: 200 })
    })

    const results = await Promise.all([ensureAccessToken(), ensureAccessToken(), ensureAccessToken(), ensureAccessToken()])
    expect(results).toEqual(Array(4).fill('access-new'))
    // The invariant that matters: one network call for four requests. Without
    // the shared promise this would be 4, and the auth service would read it as
    // refresh-token reuse.
    expect(calls).toBe(1)
  })

  it('drops the session when the auth service rejects the refresh token', async () => {
    writeSession(session({ expiresAt: Date.now() - 1000 }))
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 'reuse' } }), { status: 401 }))

    const token = await ensureAccessToken()
    expect(token).toBeNull()
    expect(readSession()).toBeNull()
  })

  it('keeps the session when the network is unreachable', async () => {
    writeSession(session({ expiresAt: Date.now() - 1000 }))
    vi.stubGlobal('fetch', async () => {
      throw new Error('ENOTFOUND')
    })

    const token = await ensureAccessToken()
    expect(token).toBeNull()
    // Offline must not log the user out — the refresh token is still good.
    expect(readSession()?.refreshToken).toBe('refresh-1')
  })
})
