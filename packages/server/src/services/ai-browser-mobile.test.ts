/**
 * Regression locks for AI browser DOM mode (phone).
 *
 * Background (measured on the device): the mobile side panel used to be a blank
 * canvas, and not because "a screenshot occasionally fails". The sidebar was mirroring
 * *system Chrome* via CDP, and Chrome is always backgrounded while the user chats, so
 * its renderer is frozen: `page.screenshot()` does not fail, it times out (8016ms /
 * 0 bytes backgrounded vs 1966ms / 890,526 bytes foregrounded), and the timeout was
 * swallowed by `.catch(() => Buffer.alloc(0))` into an empty frame. The frontend
 * therefore received `screenshot: ''` and had nothing to render — not even an error.
 *
 * The fix is not a better screenshot: this device does not screenshot at all. The
 * in-app WebView returns a structured snapshot instead. These tests lock that in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./device-bridge', () => ({
  callDevice: vi.fn(),
  deviceBridgeReady: vi.fn(() => true),
}))

import { callDevice } from './device-bridge'
import { mobileBrowserSession } from './ai-browser-mobile'

const mockCall = vi.mocked(callDevice)

/** A normal WebView snapshot answer */
function page(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      ok: true,
      url: 'https://example.com/',
      title: 'Example',
      ready: 'complete',
      text: 'hello world',
      blocks: [{ k: 'p', t: 'hello world' }],
      elements: [
        { i: 0, tag: 'a', text: 'More', href: 'https://example.com/more', rect: [0, 0, 10, 10], disabled: false },
        { i: 1, tag: 'input', text: 'Search', type: 'search', rect: [0, 12, 80, 20], disabled: false },
      ],
      ...over,
    },
  } as never
}

const navigateCalls = () => mockCall.mock.calls.filter(([k]) => k === 'browser_navigate').length

beforeEach(async () => {
  mockCall.mockReset()
  // The frame cache is module-level (one WebView per device); reset it between cases.
  await mobileBrowserSession().close()
})

describe('DOM mode — structure instead of pixels', () => {
  it('always carries a dom payload and never pretends to have a screenshot', async () => {
    mockCall.mockResolvedValue(page())
    const snap = await mobileBrowserSession().screenshot()
    // The old bug's signature was exactly "empty screenshot and nothing else to render".
    // So "dom must exist" is the invariant that actually protects the panel.
    expect(snap.dom).toBeTruthy()
    expect(snap.dom?.elements).toHaveLength(2)
    expect(snap.screenshot).toBe('')
    expect(snap.url).toBe('https://example.com/')
  })

  it('coordinate clicks fail loudly — landing on some element silently is worse than an error', async () => {
    const r = await mobileBrowserSession().clickAt(10, 20)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toMatch(/index|seq/i)
    // Not a single device command may go out: sending one means something was clicked.
    expect(mockCall).not.toHaveBeenCalled()
  })

  it('typing with no selected element fails instead of typing into the void', async () => {
    mockCall.mockResolvedValue(page())
    const r = await mobileBrowserSession().typeText('hi')
    expect(r.ok).toBe(false)
    expect(mockCall).not.toHaveBeenCalled()
  })
})

describe('DOM mode — navigation timing', () => {
  it('navigation waits for ready before answering', async () => {
    let shots = 0
    mockCall.mockImplementation((async (kind: string) => {
      if (kind === 'browser_navigate') return { ok: true, data: 'navigating' }
      shots++
      return page({ ready: shots >= 2 ? 'complete' : 'loading' })
    }) as never)

    const snap = await mobileBrowserSession().navigate('example.com')
    expect(snap.dom?.ready).toBe('complete')
    // Snapshotting once and returning would ship the previous page (or about:blank).
    expect(shots).toBeGreaterThan(1)
  })

  it('re-opening the same URL does not reload it', async () => {
    mockCall.mockResolvedValue(page())
    const s = mobileBrowserSession()
    await s.navigate('https://example.com/')
    expect(navigateCalls()).toBe(1)
    // A reload would scroll the page back to the top under the reader's finger.
    await s.navigate('https://example.com/')
    expect(navigateCalls()).toBe(1)
  })

  it('refresh really reloads — it must not be eaten by the same-URL check', async () => {
    mockCall.mockResolvedValue(page())
    const s = mobileBrowserSession()
    await s.navigate('https://example.com/')
    await s.refresh()
    expect(navigateCalls()).toBe(2)
  })
})

describe('DOM mode — one instance shared by the human and the agent', () => {
  it('an agent click updates the shared frame cache immediately', async () => {
    mockCall.mockResolvedValue(page({ url: 'https://example.com/next' }))
    const s = mobileBrowserSession()
    await s.clickIndex?.(0)
    // This is what lets the side panel show what the agent is doing: same cache.
    expect(s.lastFrame()?.url).toBe('https://example.com/next')
  })

  it('click-by-text resolves to the element index', async () => {
    mockCall.mockResolvedValue(page())
    const s = mobileBrowserSession()
    await s.clickText('Search')
    const click = mockCall.mock.calls.find(([k]) => k === 'browser_click')
    expect(click?.[1]).toMatchObject({ index: 1 })
  })
})
