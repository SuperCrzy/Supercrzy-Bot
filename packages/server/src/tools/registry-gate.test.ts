/**
 * Tool registry gates — the phone must get the phone toolset, and only that.
 *
 * Both gates here were dead code, in the worst possible way:
 *   ① the predicate was `process.platform === 'android'`, but the phone runs a stock
 *      aarch64 Node inside proot, which reports `'linux'` — so it never fired;
 *   ② the gate sets held camelCase names (`mobileBrowser`, `computerUse`) while every
 *      tool's `name` is snake_case — so even a correct predicate matched nothing.
 * Net effect on the only device these were written for: the mobile tools were filtered
 * out as "desktop-only" and the desktop ones stayed in. Phone control and the in-app
 * browser were not broken — they were never registered.
 *
 * These tests drive the real registry and assert the observable toolset, so either
 * half of the regression (wrong predicate, or a renamed tool drifting away from the
 * gate set) fails here.
 */
import { describe, it, expect, vi } from 'vitest'

async function loadRegistry(mobile: boolean): Promise<string[]> {
  vi.resetModules()
  vi.doMock('../services/device-bridge', () => ({
    deviceBridgeReady: () => mobile,
    callDevice: vi.fn(),
  }))
  const mod = await import('./registry')
  return mod.directoryTools.map((t) => t.name)
}

describe('registry — mobile tool gating', () => {
  it('desktop: has browser, no phone-only tools', async () => {
    const names = await loadRegistry(false)
    expect(names).toContain('browser')
    expect(names).not.toContain('mobile_browser')
    expect(names).not.toContain('device_control')
  })

  it('phone: has the phone-only tools and keeps none of the desktop-only ones', async () => {
    const names = await loadRegistry(true)
    expect(names).toContain('mobile_browser')
    expect(names).toContain('device_control')
    // These four would only ever throw on the phone: nut.js, a second adb device,
    // and a playwright kernel that the mobile payload prunes.
    expect(names).not.toContain('browser')
    expect(names).not.toContain('computer_use')
    expect(names).not.toContain('android_screen')
    expect(names).not.toContain('android_action')
  })
})
