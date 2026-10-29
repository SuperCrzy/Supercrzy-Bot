import { describe, expect, it } from 'vitest'
import { browserOpenCommand } from './account'

/**
 * Regression guard for the Windows sign-in failure ("回环重定向必须发送PKCE挑战",
 * reported by the boss on 2026-10-29): `cmd /c start` split the login URL at the
 * first `&`, so the browser never received `code_challenge` / `state`. The win32
 * branch must not route the URL through cmd at all, and the URL must stay a
 * single argument on every platform.
 */
describe('browserOpenCommand', () => {
  const LOGIN_URL =
    'https://auth.supercrzy.com/?returnPath=http://127.0.0.1:3000/auth/callback&code_challenge=abc&code_challenge_method=S256&state=s1'

  it('opens via the default browser without a shell on Windows', () => {
    const [cmd, args] = browserOpenCommand('win32', LOGIN_URL)
    // cmd parses `&` as a command separator; rundll32 is invoked via CreateProcess.
    expect(cmd).not.toBe('cmd')
    expect(cmd).toBe('rundll32')
    // The URL must be one intact argument — no pre-splitting, no empty title slot.
    expect(args[args.length - 1]).toBe(LOGIN_URL)
    expect(args.filter((a) => a === LOGIN_URL)).toHaveLength(1)
  })

  it('keeps every query parameter reachable on Windows', () => {
    const [, args] = browserOpenCommand('win32', LOGIN_URL)
    const url = args[args.length - 1]
    expect(url).toContain('code_challenge=abc')
    expect(url).toContain('code_challenge_method=S256')
    expect(url).toContain('state=s1')
  })

  it('uses `open` on macOS and `xdg-open` on Linux, URL intact', () => {
    expect(browserOpenCommand('darwin', LOGIN_URL)).toEqual(['open', [LOGIN_URL]])
    expect(browserOpenCommand('linux', LOGIN_URL)).toEqual(['xdg-open', [LOGIN_URL]])
  })
})
