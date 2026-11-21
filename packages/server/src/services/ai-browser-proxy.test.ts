/**
 * The OS proxy is read once at browser launch so a killed VPN client (which
 * leaves the setting behind pointing at a closed port) does not turn every page
 * into a timeout. Parsing is the part that can be wrong quietly, so it is
 * tested against real `scutil --proxy` output.
 */
import { describe, it, expect } from 'vitest'
import { parseMacSystemProxy } from './ai-browser'

// Captured from `scutil --proxy` on macOS 15 with an HTTP+HTTPS proxy set.
const REAL_OUTPUT = `<dictionary> {
  ExceptionsList : <array> {
    0 : captive.apple.com
    1 : localhost
  }
  ExcludeSimpleHostnames : 1
  HTTPEnable : 1
  HTTPPort : 1082
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 1082
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 0
}`

describe('parseMacSystemProxy', () => {
    it('reads host and port from real output', () => {
        expect(parseMacSystemProxy(REAL_OUTPUT)).toEqual({ host: '127.0.0.1', port: 1082 })
    })

    it('returns null when the proxy is configured but disabled', () => {
        const disabled = REAL_OUTPUT.replace('HTTPEnable : 1', 'HTTPEnable : 0')
            .replace('HTTPSEnable : 1', 'HTTPSEnable : 0')
        expect(parseMacSystemProxy(disabled)).toBeNull()
    })

    it('accepts HTTPS-only configurations', () => {
        const httpsOnly = REAL_OUTPUT.replace('HTTPEnable : 1', 'HTTPEnable : 0')
        expect(parseMacSystemProxy(httpsOnly)).toEqual({ host: '127.0.0.1', port: 1082 })
    })

    it('returns null when no proxy keys are present at all', () => {
        expect(parseMacSystemProxy('<dictionary> {\n  SOCKSEnable : 0\n}')).toBeNull()
    })

    it('rejects an out-of-range port instead of passing it to Chrome', () => {
        expect(parseMacSystemProxy(REAL_OUTPUT.replace('HTTPPort : 1082', 'HTTPPort : 99999'))).toBeNull()
    })
})
