/** Map synchronization failures to messages that explain the next safe action. */
export function syncErrorMessageKey(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'account_changed') return 'settings.e2eAccountChanged'
  if (message === 'not_signed_in') return 'settings.e2eSignInAgain'
  if (message === 'account_header_required') return 'settings.e2eClientUpdate'
  if (message.startsWith('decrypt_failed:')) return 'settings.e2eInvalidData'
  if (message === 'Invalid sync cursor' || message === 'Invalid sync page') return 'settings.e2eInvalidPage'
  if (message === 'sync_in_progress') return 'settings.e2eSyncInProgress'
  if (message === 'e2e_locked') return 'settings.e2eUnlockFirst'
  return 'settings.e2eSyncFailed'
}
