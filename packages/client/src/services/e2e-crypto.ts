/**
 * Client-side E2E crypto (M8 P2). Zero-knowledge: the DEK never leaves this
 * process unencrypted, and the server only ever sees ciphertext.
 *
 * Model (matches supercrzy-auth accounts.ts envelope fields):
 *   passphrase --PBKDF2-SHA256(salt, 600k)--> KEK
 *   random DEK (AES-256-GCM) --wrapped by KEK--> wrappedDek
 *   envelope = { version: 1, kdf: JSON params, salt, wrappedDek, recoveryBlob? }
 *   blob     = base64(iv || AES-GCM ciphertext)
 *
 * Every parameter here must stay in lockstep with the IdP's e2e envelope
 * schema (routes/auth.ts PUT /auth/me/e2e: version/kdf/salt/wrappedDek).
 */

const PBKDF2_ITERATIONS = 600_000
const ENVELOPE_VERSION = 1

/** Result of a successful KDF derivation, kept in memory only. */
export interface UnlockedKey {
  dek: CryptoKey
  /** Raw DEK bytes, needed to re-wrap when the user rotates the passphrase. */
  raw: ArrayBuffer
}

/** Parse the IdP's `kdf` JSON string back into parameters. */
export function parseKdf(kdfJson: string): { algo: string; iterations: number; hash: string } {
  const parsed = JSON.parse(kdfJson) as { algo: string; iterations: number; hash: string }
  if (parsed.algo !== 'PBKDF2-SHA256') throw new Error(`unsupported kdf algo: ${parsed.algo}`)
  return parsed
}

async function deriveKek(passphrase: string, saltBytes: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase) as unknown as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

function toB64(bytes: Uint8Array | ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

/**
 * First-time setup: generate a fresh DEK, wrap it with the passphrase-derived
 * KEK and return the envelope to PUT to /api/account/e2e.
 */
export async function createEnvelope(
  passphrase: string,
): Promise<{
  envelope: { version: number; kdf: string; salt: string; wrappedDek: string; recoveryBlob: null }
  unlocked: UnlockedKey
}> {
  if (passphrase.length < 12) throw new Error('passphrase_too_short')
  const salt = randomBytes(16)
  const kek = await deriveKek(passphrase, salt)
  const rawDek = crypto.getRandomValues(new Uint8Array(32))
  const dek = await crypto.subtle.importKey('raw', rawDek as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  // Wrap the raw DEK bytes with the KEK (AES-GCM wrap with fresh IV).
  const iv = randomBytes(12)
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, kek, rawDek as unknown as BufferSource)
  // wrappedDek = base64(iv || ciphertext) so unwrap is self-contained.
  const wrappedB64 = toB64(new Uint8Array([...iv, ...new Uint8Array(wrapped)]))
  return {
    envelope: {
      version: ENVELOPE_VERSION,
      kdf: JSON.stringify({ algo: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }),
      salt: toB64(salt),
      wrappedDek: wrappedB64,
      recoveryBlob: null,
    },
    unlocked: { dek, raw: rawDek.buffer as ArrayBuffer },
  }
}

/** Unlock an existing envelope: derive the KEK, unwrap the DEK. */
export async function unlockEnvelope(
  passphrase: string,
  envelope: { kdf: string; salt: string; wrappedDek: string },
): Promise<UnlockedKey> {
  const params = parseKdf(envelope.kdf)
  if (params.iterations !== PBKDF2_ITERATIONS) throw new Error('kdf_params_mismatch')
  const kek = await deriveKek(passphrase, fromB64(envelope.salt))
  const packed = fromB64(envelope.wrappedDek)
  const iv = packed.slice(0, 12)
  const wrapped = packed.slice(12)
  const rawDek = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, kek, wrapped as unknown as BufferSource)
  const dek = await crypto.subtle.importKey('raw', rawDek as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  return { dek, raw: rawDek }
}

/** Encrypt a JSON-serialisable payload into a base64 blob. */
export async function encryptBlob(dek: CryptoKey, payload: unknown): Promise<string> {
  const iv = randomBytes(12)
  const plaintext = new TextEncoder().encode(JSON.stringify(payload))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, dek, plaintext as unknown as BufferSource)
  return toB64(new Uint8Array([...iv, ...new Uint8Array(ciphertext)]))
}

/** Decrypt a blob produced by encryptBlob. */
export async function decryptBlob<T>(dek: CryptoKey, blob: string): Promise<T> {
  const packed = fromB64(blob)
  const iv = packed.slice(0, 12)
  const ciphertext = packed.slice(12)
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, dek, ciphertext as unknown as BufferSource)
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}

/**
 * Account-scoped E2E API surface. All calls go through the local server's
 * passthrough routes (/api/account/e2e) — the browser never talks to the IdP
 * directly, mirroring how login/status already work.
 */
export class E2eApi {
  constructor(private getAccessToken: () => string | null) {}

  async getEnvelope(): Promise<{ envelope: Record<string, unknown> | null } | null> {
    const res = await fetch('/api/account/e2e')
    if (res.status === 401) return null
    if (!res.ok) throw new Error(`e2e GET ${res.status}`)
    return res.json()
  }

  async putEnvelope(envelope: Record<string, unknown>): Promise<void> {
    const res = await fetch('/api/account/e2e', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    })
    if (!res.ok) throw new Error(`e2e PUT ${res.status}`)
  }
}

/** Passphrase strength gate: length-first, no complexity rules (decision #2). */
export function passphraseError(passphrase: string): string | null {
  if (passphrase.length < 12) return 'passphrase_too_short'
  return null
}
