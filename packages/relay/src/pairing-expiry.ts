/** Revoke an unclaimed pairing identity whenever its code expires. */
export function expirePendingPairing(
  code: string,
  now: number,
  pending: Map<string, { token: string; expiresAt: number }>,
  issuedTokens: Set<string>,
  disconnect: (token: string) => void,
): boolean {
  const entry = pending.get(code)
  if (!entry || entry.expiresAt > now) return false
  pending.delete(code)
  issuedTokens.delete(entry.token)
  disconnect(entry.token)
  return true
}
