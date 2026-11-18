/**
 * E2E crypto unit tests. Web Crypto is available in Node 22 (globalThis.crypto),
 * so the full wrap/unwrap round-trip is testable without a browser.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  createEnvelope,
  unlockEnvelope,
  encryptBlob,
  decryptBlob,
  passphraseError,
  parseKdf,
  E2eApi,
} from './e2e-crypto'

describe('e2e-crypto', () => {
  it('binds envelope writes to the expected account', async () => {
    const fetcher = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetcher)
    try {
      const api = new E2eApi(() => null)
      await expect(api.putEnvelope({}, '')).rejects.toThrow('account_header_required')
      expect(fetcher).not.toHaveBeenCalled()
      await api.putEnvelope({ wrappedDek: 'encrypted' }, 'account-a')
      expect(fetcher).toHaveBeenCalledWith('/api/account/e2e', expect.objectContaining({ headers: expect.objectContaining({ 'X-Supercrzy-Account': 'account-a' }) }))
    } finally { vi.unstubAllGlobals() }
  })
  it('round-trips: create → unlock → encrypt → decrypt', async () => {
    const { envelope, unlocked } = await createEnvelope('correct horse battery staple')
    expect(envelope.version).toBe(1)
    expect(envelope.recoveryBlob).toBeNull()

    const parsed = parseKdf(envelope.kdf)
    expect(parsed.algo).toBe('PBKDF2-SHA256')
    expect(parsed.iterations).toBe(600_000)

    // Unlock with the same passphrase must yield a DEK that decrypts what the
    // original DEK encrypted — proven by cross-decrypting a shared payload.
    const unlocked2 = await unlockEnvelope('correct horse battery staple', envelope)
    const blob = await encryptBlob(unlocked.dek, { hello: '世界', n: 42 })
    const out = await decryptBlob<{ hello: string; n: number }>(unlocked2.dek, blob)
    expect(out).toEqual({ hello: '世界', n: 42 })
  })

  it('rejects a wrong passphrase at unlock', async () => {
    const { envelope } = await createEnvelope('correct horse battery staple')
    await expect(unlockEnvelope('wrong horse battery staple', envelope)).rejects.toThrow()
  })

  it('encrypts and decrypts a large session within the cloud item limit', async () => {
    const { unlocked } = await createEnvelope('correct horse battery staple')
    const payload = { messages: [{ role: 'user', content: '长会话🙂'.repeat(45_000) }] }
    const blob = await encryptBlob(unlocked.dek, payload)
    expect(blob.length).toBeLessThan(1024 * 1024)
    expect(await decryptBlob(unlocked.dek, blob)).toEqual(payload)
  })

  it('wrong DEK cannot decrypt a blob (authenticity)', async () => {
    const a = await createEnvelope('correct horse battery staple')
    const b = await createEnvelope('another correct horse staple!!')
    const blob = await encryptBlob(a.unlocked.dek, { secret: true })
    await expect(decryptBlob(b.unlocked.dek, blob)).rejects.toThrow()
  })

  it('enforces the 12-char passphrase floor', () => {
    expect(passphraseError('short')).toBe('passphrase_too_short')
    expect(passphraseError('twelve chars at least')).toBeNull()
  })

  it('kdf params mismatch is rejected on unlock', async () => {
    const { envelope } = await createEnvelope('correct horse battery staple')
    const tampered = { ...envelope, kdf: JSON.stringify({ algo: 'PBKDF2-SHA256', iterations: 1000, hash: 'SHA-256' }) }
    await expect(unlockEnvelope('correct horse battery staple', tampered)).rejects.toThrow('kdf_params_mismatch')
  })
})
