/**
 * Sign-in gate for sending.
 *
 * Every `/api/*` path outside the public allowlist answers 401 without an account,
 * so a send from a signed-out window can only fail. The two cases need the same
 * prompt: the pre-send check (no account at all) and a 401 mid-stream (the account
 * expired while the app stayed open). Kept as plain functions so the contract is
 * assertable without mounting the composer.
 */

/** The status the account middleware returns when no valid token exists. */
export const SIGN_IN_REQUIRED_STATUS = 401

/** Whether a failed response means "sign in", not "network died". */
export function isAuthFailure(status: number): boolean {
  return status === SIGN_IN_REQUIRED_STATUS
}

/** Whether a send must be stopped before any request leaves the client. */
export function blocksSend(signedIn: boolean): boolean {
  return !signedIn
}
