import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSession, writeSession, type StoredSession } from './account-store'

let dir: string
const session: StoredSession = { accountId: 'fixture', email: '', deviceId: 'fixture', accessToken: 'access', refreshToken: 'refresh', expiresAt: 1, savedAt: 1 }
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'supercrzy-account-recovery-')); process.env.SC_AUTH_DIR = dir })
afterEach(() => { delete process.env.SC_AUTH_DIR; rmSync(dir, { recursive: true, force: true }) })

describe('account session recovery', () => {
  it('preserves a malformed key and ciphertext instead of replacing either', () => {
    writeSession(session)
    const ciphertext = readFileSync(join(dir, 'auth.json'), 'utf8')
    writeFileSync(join(dir, '.auth-key'), 'damaged')
    expect(() => readSession()).toThrow('account_key_invalid')
    expect(() => writeSession(session)).toThrow('account_key_invalid')
    expect(readFileSync(join(dir, '.auth-key'), 'utf8')).toBe('damaged')
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe(ciphertext)
  })

  it('does not generate a replacement key for an existing encrypted session', () => {
    writeSession(session)
    const ciphertext = readFileSync(join(dir, 'auth.json'), 'utf8')
    rmSync(join(dir, '.auth-key'))
    expect(() => readSession()).toThrow('account_key_missing')
    expect(() => writeSession(session)).toThrow('account_key_missing')
    expect(existsSync(join(dir, '.auth-key'))).toBe(false)
    expect(readFileSync(join(dir, 'auth.json'), 'utf8')).toBe(ciphertext)
  })

  it('saves and reads a session without leaving temporary files', () => {
    writeSession(session)
    expect(readSession()).toEqual(session)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
