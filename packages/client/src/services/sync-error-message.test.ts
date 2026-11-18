import { describe, expect, it } from 'vitest'
import { syncErrorMessageKey } from './sync-error-message'

describe('sync error messages', () => {
  it.each([
    ['account_changed', 'settings.e2eAccountChanged'],
    ['not_signed_in', 'settings.e2eSignInAgain'],
    ['account_header_required', 'settings.e2eClientUpdate'],
    ['decrypt_failed:3', 'settings.e2eInvalidData'],
    ['Invalid sync cursor', 'settings.e2eInvalidPage'],
    ['Invalid sync page', 'settings.e2eInvalidPage'],
    ['unexpected error', 'settings.e2eSyncFailed'],
  ])('maps %s to a safe user message', (error, expected) => {
    expect(syncErrorMessageKey(new Error(error))).toBe(expected)
  })
})
