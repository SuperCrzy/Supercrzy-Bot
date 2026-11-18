import { describe, expect, it, vi } from 'vitest'
import { expirePendingPairing } from '../src/pairing-expiry.js'

describe('unclaimed pairing expiry', () => {
  it('revokes the token and disconnects its peer at the expiry boundary', () => {
    const pending = new Map([['123456', { token: 'mobile-token', expiresAt: 100 }]])
    const issued = new Set(['mobile-token', 'other-token'])
    const disconnect = vi.fn()
    expect(expirePendingPairing('123456', 99, pending, issued, disconnect)).toBe(false)
    expect(issued.has('mobile-token')).toBe(true)
    expect(expirePendingPairing('123456', 100, pending, issued, disconnect)).toBe(true)
    expect(pending.has('123456')).toBe(false)
    expect(issued.has('mobile-token')).toBe(false)
    expect(issued.has('other-token')).toBe(true)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledWith('mobile-token')
    expect(expirePendingPairing('123456', 101, pending, issued, disconnect)).toBe(false)
  })
})
