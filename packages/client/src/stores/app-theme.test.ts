/**
 * Theme state, exercised through the two entries the View menu exposes.
 *
 * The menu shows light and dark as separate checked items, which means picking the
 * one already active must be a no-op rather than a flip. When this was a single
 * toggle, choosing "light" while already light switched the user to dark — the exact
 * confusion the checked items were meant to remove.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// app.ts pulls in @/i18n, which builds a vue-i18n instance at import time.
vi.mock('@/i18n', () => ({ default: () => ({ global: { t: (key: string) => key } }) }))
vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return { ...actual, useI18n: () => ({ t: (k: string) => k, locale: { value: 'zh-CN' } }) }
})

const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }))
let storage: Map<string, string>

describe('app store theme', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // The suite runs in the node environment, which has no localStorage.
    storage = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    })
    vi.stubGlobal('fetch', fetchSpy)
    fetchSpy.mockClear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('setDarkMode(true) lands on dark', async () => {
    const { useAppStore } = await import('./app')
    const s = useAppStore()
    s.setDarkMode(true)
    expect(s.darkMode).toBe(true)
    expect(localStorage.getItem('supercrzy:theme')).toBe('dark')
  })

  it('setDarkMode(false) lands on light', async () => {
    const { useAppStore } = await import('./app')
    const s = useAppStore()
    s.setDarkMode(true)
    s.setDarkMode(false)
    expect(s.darkMode).toBe(false)
    expect(localStorage.getItem('supercrzy:theme')).toBe('light')
  })

  it('choosing the theme already active does not flip it', async () => {
    const { useAppStore } = await import('./app')
    const s = useAppStore()
    // Start from dark, then click "Light mode" twice. The initial ref is already
    // false, so starting from light would make the first call a no-op for the
    // wrong reason and hide a toggle behind an unchanged value.
    s.setDarkMode(true)
    s.setDarkMode(false)
    expect(s.darkMode).toBe(false)
    // Second click on the already-checked item. A toggle would flip back to dark.
    s.setDarkMode(false)
    expect(s.darkMode).toBe(false)
  })

  it('the sidebar button still toggles', async () => {
    const { useAppStore } = await import('./app')
    const s = useAppStore()
    expect(s.darkMode).toBe(false)
    s.toggleDarkMode()
    expect(s.darkMode).toBe(true)
    s.toggleDarkMode()
    expect(s.darkMode).toBe(false)
  })

  it('re-picking the same theme does not re-post settings', async () => {
    const { useAppStore } = await import('./app')
    const s = useAppStore()
    s.setDarkMode(true)
    fetchSpy.mockClear()
    s.setDarkMode(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
