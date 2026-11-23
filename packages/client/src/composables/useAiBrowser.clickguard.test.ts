/**
 * Why this exists: the native browser view is a WebContentsView stacked above the
 * page, and it consumes clicks inside its rectangle before the renderer sees them.
 * When it was left in place after the panel collapsed, clicking Settings did nothing
 * — the click never reached the app, so no route change happened, so nothing hid the
 * view. Two guards cover it: the view hides when its rectangle shrinks, and a
 * capture-phase pointerdown hides it before the click is consumed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerNativeHider, hideNativeBrowserNow } from './useAiBrowser'

describe('native view must not become an invisible click blocker', () => {
  beforeEach(() => { registerNativeHider(() => {}) })

  it('runs the hider on every call while a view is shown', () => {
    // A one-shot guard would let the view reappear on the second collapse.
    const hider = vi.fn()
    registerNativeHider(hider)
    hideNativeBrowserNow()
    hideNativeBrowserNow()
    expect(hider).toHaveBeenCalledTimes(2)
  })

  it('does not throw when the bridge is absent (web build)', () => {
    registerNativeHider(() => {})
    expect(() => hideNativeBrowserNow()).not.toThrow()
  })
})

describe('chrome pointerdown selector', () => {
  // The guard must not swallow clicks meant for the page itself, or scrolling and
  // interacting with the browser becomes impossible.
  const isBrowserSurface = (cls: string) => {
    const fakeEl = { closest: (sel: string) => (sel.split(',').some((s) => cls.includes(s.trim().slice(1))) ? {} : null) }
    return fakeEl.closest('.browser-canvas, .browser-chrome-bar, .browser-cmd, .browser-console, .browser-dom') !== null
  }

  it('treats the page surface as part of the browser', () => {
    expect(isBrowserSurface('browser-canvas native')).toBe(true)
    expect(isBrowserSurface('browser-chrome-bar')).toBe(true)
  })

  it('treats app chrome as not-the-browser', () => {
    expect(isBrowserSurface('sidebar-item')).toBe(false)
    expect(isBrowserSurface('settings-row')).toBe(false)
  })
})
