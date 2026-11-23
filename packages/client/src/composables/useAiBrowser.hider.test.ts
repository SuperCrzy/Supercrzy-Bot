/**
 * The native browser view is drawn above the page by the main process, so nothing in
 * the renderer can cover it — no z-index, no modal. That makes hiding it a
 * correctness requirement whenever a full-page route opens, and the bug was that
 * closing the detail panel did not reliably reach it: the panel is controlled by a
 * class (not v-if), so no unmount fired, and the view sat on top of the changelog.
 *
 * These tests pin the contract MainLayout relies on: a registered hider runs, and
 * calling it with nothing registered is harmless.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerNativeHider, hideNativeBrowserNow } from './useAiBrowser'

describe('native browser hider', () => {
  beforeEach(() => {
    // Reset between cases: the registry is module-level so one test's hider would
    // otherwise leak into the next.
    registerNativeHider(() => {})
  })

  it('runs the registered hider', () => {
    const hider = vi.fn()
    registerNativeHider(hider)
    hideNativeBrowserNow()
    expect(hider).toHaveBeenCalledTimes(1)
  })

  it('is safe when no view was ever registered', () => {
    // Not a desktop build: there is no bridge, and the route change must not throw.
    registerNativeHider(() => {})
    expect(() => hideNativeBrowserNow()).not.toThrow()
  })

  it('swallows an error from a torn-down view', () => {
    // Hiding a destroyed WebContentsView can throw; a route change must still land.
    registerNativeHider(() => { throw new Error('view destroyed') })
    expect(() => hideNativeBrowserNow()).not.toThrow()
  })
})
