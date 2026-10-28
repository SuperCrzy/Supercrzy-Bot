/**
 * Encrypted storage for the desktop app's account session.
 *
 * The session file holds a refresh token, so it must not sit on disk in the
 * clear: a backup, a sync folder, or a support bundle would leak it. We encrypt
 * with AES-256-GCM under a key kept in a separate 0600 file. That stops the
 * "copied another file" class of leak, which is the realistic one for a local
 * tool — an attacker who can already read the whole home directory is out of
 * scope for any file-based scheme.
 *
 * The directory can be overridden with SC_AUTH_DIR so tests never touch the
 * real profile.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AAD = Buffer.from('supercrzy-auth-session-v1')

/** How long a session survives without a successful refresh. */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface StoredSession {
  accountId: string
  email: string
  deviceId: string
  accessToken: string
  refreshToken: string
  /** Epoch ms at which the access token stops being usable. */
  expiresAt: number
  savedAt: number
}

function dataDir(): string {
  return process.env.SC_AUTH_DIR || join(homedir(), '.supercrzy', 'data')
}
function sessionPath(): string {
  return join(dataDir(), 'auth.json')
}
function keyPath(): string {
  return join(dataDir(), '.auth-key')
}

function loadKey(): Buffer {
  const file = keyPath()
  if (existsSync(file)) {
    const raw = readFileSync(file)
    if (raw.length === 32) return raw
  }
  mkdirSync(dataDir(), { recursive: true })
  const key = randomBytes(32)
  writeFileSync(file, key, { mode: 0o600 })
  return key
}

function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(AAD)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

function decrypt(payload: string, key: Buffer): string | null {
  try {
    const raw = Buffer.from(payload, 'base64')
    if (raw.length < 29) return null
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const body = raw.subarray(28)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(AAD)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export function readSession(): StoredSession | null {
  const file = sessionPath()
  if (!existsSync(file)) return null
  const plain = decrypt(readFileSync(file, 'utf8').trim(), loadKey())
  if (!plain) return null
  try {
    const parsed = JSON.parse(plain) as StoredSession
    if (!parsed.refreshToken || !parsed.accountId) return null
    return parsed
  } catch {
    return null
  }
}

export function writeSession(session: StoredSession): void {
  mkdirSync(dataDir(), { recursive: true })
  const payload = encrypt(JSON.stringify(session), loadKey())
  // Write-then-rename so a crash mid-write cannot leave a truncated session.
  const tmp = sessionPath() + '.tmp'
  writeFileSync(tmp, payload, { mode: 0o600 })
  renameSync(tmp, sessionPath())
}

export function clearSession(): void {
  const file = sessionPath()
  if (existsSync(file)) rmSync(file, { force: true })
}

/** Access token if one exists and has not expired; otherwise null. */
export function currentAccessToken(now = Date.now()): string | null {
  const s = readSession()
  if (!s) return null
  if (s.expiresAt && s.expiresAt <= now) return null
  return s.accessToken
}

/**
 * Signed in means "there is a refresh token that has not aged out", not "the
 * access token is still valid". An expired access token is normal — the gate
 * rotates it on the next request — and treating that as signed-out would bounce
 * people to the login screen every 15 minutes.
 */
export function isSignedIn(now = Date.now()): boolean {
  const s = readSession()
  if (!s || !s.refreshToken) return false
  return now - (s.savedAt || 0) < REFRESH_TTL_MS
}
