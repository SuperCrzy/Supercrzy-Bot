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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AAD = Buffer.from('supercrzy-auth-session-v1')
const sessionListeners = new Set<() => void>()

/** Subscribe to local session writes/removals. No credentials are exposed. */
export function onSessionChange(listener: () => void): () => void {
  sessionListeners.add(listener)
  return () => { sessionListeners.delete(listener) }
}

function notifySessionChange(): void {
  for (const listener of sessionListeners) {
    try { listener() } catch { /* a subscriber must not break account storage */ }
  }
}

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
    throw new Error('account_key_invalid')
  }
  // Never replace a missing key when an encrypted session already exists: a
  // replacement key cannot decrypt it and would destroy a recovery clue.
  if (existsSync(sessionPath())) throw new Error('account_key_missing')
  mkdirSync(dataDir(), { recursive: true })
  const key = randomBytes(32)
  try {
    writeFileSync(file, key, { mode: 0o600, flag: 'wx' })
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = readFileSync(file)
    if (existing.length !== 32) throw new Error('account_key_invalid')
    return existing
  }
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
  // A session left behind as auth.json.tmp is still a signed-in session.
  //
  // An earlier write path produced "<file>.tmp" without the random suffix this one
  // uses, and never renamed it into place — so the only copy of a valid login sat
  // under a name nothing read. Every account-gated endpoint then answered 401 while
  // the user was, as far as they could tell, signed in. Read the fallback, and adopt
  // it: the next successful write replaces it properly.
  // readTextIfFile, not existsSync + readFileSync: existsSync returns true for a
  // directory, and reading one throws — which would take down every account-gated
  // request rather than reporting "signed out". A damaged auth.json should look like
  // no session, not like a broken server.
  let raw: string | null = null
  for (const candidate of [file, `${file}.tmp`]) {
    try {
      if (statSync(candidate).isFile()) { raw = readFileSync(candidate, 'utf8').trim(); break }
    } catch { /* missing or unreadable: try the next candidate */ }
  }
  if (!raw) return null
  const plain = decrypt(raw, loadKey())
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
  const tmp = `${sessionPath()}.${randomBytes(16).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, payload, { mode: 0o600, flag: 'wx' })
    renameSync(tmp, sessionPath())
  } finally {
    rmSync(tmp, { force: true })
  }
  // A legacy "<file>.tmp" is now redundant once a real file exists, and leaving it
  // means readSession keeps falling back to a stale copy if auth.json is ever
  // removed. Best-effort: failing to clean up must not fail the write.
  const legacy = `${sessionPath()}.tmp`
  try { if (existsSync(legacy)) rmSync(legacy, { force: true }) } catch { /* keep going */ }
  notifySessionChange()
}

export function clearSession(): void {
  const file = sessionPath()
  // readSession can recover an older session from this legacy path. Remove it
  // before the primary file so a logout cannot resurrect the fallback session.
  const legacy = `${file}.tmp`
  if (existsSync(legacy)) rmSync(legacy, { force: true })
  if (existsSync(file)) rmSync(file, { force: true })
  notifySessionChange()
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
