/**
 * A signed-in session must be readable regardless of which filename a previous
 * build left it under.
 *
 * The failure this covers: writeSession renames a temp file into auth.json, but an
 * earlier path produced "auth.json.tmp" and never renamed it. readSession looked
 * only at auth.json, found nothing, and reported signed-out — so every account-gated
 * endpoint returned 401 while the user was still, in fact, signed in. The goal bar's
 * Start button did nothing for exactly this reason.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, randomBytes } from 'node:crypto'

const AAD = Buffer.from('supercrzy-auth-session-v1')
let dir: string
let prevDir: string | undefined

/** Mirror of the real encrypt(), so the fixture is a genuine session file. */
function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sc-auth-'))
  prevDir = process.env.SC_AUTH_DIR
  process.env.SC_AUTH_DIR = dir
})

afterEach(() => {
  if (prevDir === undefined) delete process.env.SC_AUTH_DIR
  else process.env.SC_AUTH_DIR = prevDir
  rmSync(dir, { recursive: true, force: true })
})

async function loadModule() {
  // Re-imported per test so loadKey() re-reads the temp directory.
  return await import('./account-store')
}

describe('readSession with a session left as auth.json.tmp', () => {
  it('reads a session that was never renamed into place', async () => {
    const key = randomBytes(32)
    writeFileSync(join(dir, '.auth-key'), key, { mode: 0o600 })
    writeFileSync(join(dir, 'auth.json.tmp'), seal(JSON.stringify({
      accountId: 'acc-1', refreshToken: 'r', accessToken: 'a', savedAt: Date.now(),
    }), key), { mode: 0o600 })

    const { readSession, isSignedIn } = await loadModule()
    expect(readSession()?.accountId).toBe('acc-1')
    expect(isSignedIn()).toBe(true)
  })

  it('prefers auth.json when both exist', async () => {
    const key = randomBytes(32)
    writeFileSync(join(dir, '.auth-key'), key, { mode: 0o600 })
    writeFileSync(join(dir, 'auth.json'), seal(JSON.stringify({
      accountId: 'from-real', refreshToken: 'r', accessToken: 'a', savedAt: Date.now(),
    }), key), { mode: 0o600 })
    writeFileSync(join(dir, 'auth.json.tmp'), seal(JSON.stringify({
      accountId: 'from-tmp', refreshToken: 'r', accessToken: 'a', savedAt: Date.now(),
    }), key), { mode: 0o600 })

    const { readSession } = await loadModule()
    expect(readSession()?.accountId).toBe('from-real')
  })

  it('does not resurrect a legacy session after logout', async () => {
    const key = randomBytes(32)
    writeFileSync(join(dir, '.auth-key'), key, { mode: 0o600 })
    const session = seal(JSON.stringify({ accountId: 'legacy', refreshToken: 'r', accessToken: 'a', savedAt: Date.now() }), key)
    writeFileSync(join(dir, 'auth.json'), session, { mode: 0o600 })
    writeFileSync(join(dir, 'auth.json.tmp'), session, { mode: 0o600 })
    const { clearSession, readSession, isSignedIn } = await loadModule()
    clearSession()
    expect(readSession()).toBeNull()
    expect(isSignedIn()).toBe(false)
    expect(existsSync(join(dir, 'auth.json.tmp'))).toBe(false)
  })

  it('reports signed-out when neither file exists', async () => {
    const { readSession, isSignedIn } = await loadModule()
    expect(readSession()).toBeNull()
    expect(isSignedIn()).toBe(false)
  })

  it('does not invent a session from an undecryptable file', async () => {
    // Wrong key: the file is there but it is not this machine's session.
    writeFileSync(join(dir, '.auth-key'), randomBytes(32), { mode: 0o600 })
    writeFileSync(join(dir, 'auth.json.tmp'), seal('{"accountId":"x"}', randomBytes(32)), { mode: 0o600 })
    const { readSession } = await loadModule()
    expect(readSession()).toBeNull()
  })

  it('leaves the legacy session readable when the write fails', async () => {
    // Construct the case where "delete first" would actually destroy the login: the
    // legacy copy can be removed, but the rename cannot land. Occupying auth.json with
    // a directory does exactly that — renameSync fails on a non-empty target dir while
    // removing a file is unaffected.
    const key = randomBytes(32)
    writeFileSync(join(dir, '.auth-key'), key, { mode: 0o600 })
    writeFileSync(join(dir, 'auth.json.tmp'), seal(JSON.stringify({
      accountId: 'legacy', refreshToken: 'keep-me', accessToken: 'a', savedAt: Date.now(),
    }), key), { mode: 0o600 })
    mkdirSync(join(dir, 'auth.json'))
    writeFileSync(join(dir, 'auth.json', 'blocker'), 'x')

    const { writeSession, readSession } = await loadModule()
    expect(() => writeSession({ accountId: 'legacy', refreshToken: 'new', accessToken: 'a2', savedAt: Date.now() } as never)).toThrow()
    // A failed write must not cost the user their session.
    expect(readSession()?.refreshToken).toBe('keep-me')
    rmSync(join(dir, 'auth.json'), { recursive: true, force: true })
  })

  it('removes the legacy file only after auth.json is in place', async () => {
    // Ordering matters: if the legacy copy were removed first and the rename then
    // failed, the only valid session would be gone with nothing to replace it.
    const key = randomBytes(32)
    writeFileSync(join(dir, '.auth-key'), key, { mode: 0o600 })
    writeFileSync(join(dir, 'auth.json.tmp'), seal(JSON.stringify({
      accountId: 'legacy', refreshToken: 'r', accessToken: 'a', savedAt: Date.now(),
    }), key), { mode: 0o600 })

    const { writeSession, readSession } = await loadModule()
    writeSession({ accountId: 'legacy', refreshToken: 'r2', accessToken: 'a2', savedAt: Date.now() } as never)
    // Real file exists, legacy copy is gone, and reading still works.
    expect(existsSync(join(dir, 'auth.json'))).toBe(true)
    expect(existsSync(join(dir, 'auth.json.tmp'))).toBe(false)
    expect(readSession()?.refreshToken).toBe('r2')
  })

  it('writes a proper auth.json afterwards', async () => {
    const key = randomBytes(32)
    writeFileSync(join(dir, '.auth-key'), key, { mode: 0o600 })
    writeFileSync(join(dir, 'auth.json.tmp'), seal(JSON.stringify({
      accountId: 'legacy', refreshToken: 'r', accessToken: 'a', savedAt: Date.now(),
    }), key), { mode: 0o600 })

    const { writeSession } = await loadModule()
    writeSession({ accountId: 'legacy', refreshToken: 'r2', accessToken: 'a2', savedAt: Date.now() } as never)
    expect(existsSync(join(dir, 'auth.json'))).toBe(true)
  })
})
