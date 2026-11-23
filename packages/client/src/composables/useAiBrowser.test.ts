// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { useAiBrowser } from './useAiBrowser'

let app: ReturnType<typeof createApp> | undefined
afterEach(() => { app?.unmount(); app = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

function mountBrowser(sessionId = () => 'session-a', active = () => false) {
  let browser!: ReturnType<typeof useAiBrowser>
  app = createApp(defineComponent({ setup() {
    browser = useAiBrowser({ sessionId, active })
    return () => h('div')
  } }))
  const node = document.createElement('div')
  document.body.appendChild(node)
  app.mount(node)
  return browser
}

describe('AI browser manual actions', () => {
  it('treats a negative action result without an error string as failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/act') ? { result: { ok: false } } : {}))))
    const browser = mountBrowser()
    browser.browserTypeText.value = 'keep me'
    await browser.doType(false)
    expect(browser.browserTypeText.value).toBe('keep me')
    expect(browser.browserStatus.value).toBe('动作失败')
    expect(browser.browserFailHint.value).toBeTruthy()
  })

  it('prevents overlapping navigation and keeps a new address typed while loading', async () => {
    let finish!: (r: Response) => void
    const fetchMock = vi.fn((url: string) => url.endsWith('/navigate')
      ? new Promise<Response>((resolve) => { finish = resolve })
      : Promise.resolve(new Response('{}')))
    vi.stubGlobal('fetch', fetchMock)
    const browser = mountBrowser()
    browser.browserUrlInput.value = 'https://first.test'
    const pending = browser.goToUrl()
    browser.browserUrlInput.value = 'https://next.test'
    await browser.goToUrl()
    await browser.refreshPage()
    finish(new Response(JSON.stringify({ url: 'https://first.test/' })))
    await pending
    expect(browser.browserUrl.value).toBe('https://first.test/')
    expect(browser.browserUrlInput.value).toBe('https://next.test')
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/navigate'))).toHaveLength(1)
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/refresh'))).toBe(false)
  })

  it('limits polling when the server returns empty responses immediately', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/latest') ? { ts: 0 } : {})))
    vi.stubGlobal('fetch', fetchMock)
    mountBrowser(() => 'session-a', () => true)
    await vi.advanceTimersByTimeAsync(1000)
    const polls = fetchMock.mock.calls.filter((call) => String(call[0]).includes('/latest')).length
    expect(polls).toBe(5)
    app?.unmount()
    app = undefined
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes('/latest'))).toHaveLength(polls)
  })

  it('preserves text edited while an input request is in flight', async () => {
    let finish!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/act')
      ? new Promise<Response>((resolve) => { finish = resolve })
      : Promise.resolve(new Response('{}'))))
    const browser = mountBrowser()
    browser.browserTypeText.value = 'first'
    const pending = browser.doType(false)
    browser.browserTypeText.value = 'new draft'
    finish(new Response(JSON.stringify({ result: {} })))
    await pending
    expect(browser.browserTypeText.value).toBe('new draft')
  })

  it('clears the old operation log and ignores a late action when switching sessions', async () => {
    let finish!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/act')
      ? new Promise<Response>((resolve) => { finish = resolve })
      : Promise.resolve(new Response('{}'))))
    const sid = ref('session-a')
    const browser = mountBrowser(() => sid.value)
    browser.browserLog.value.push('old session')
    const pending = browser.browserGoBack()
    sid.value = 'session-b'
    finish(new Response(JSON.stringify({ result: {} })))
    await pending
    expect(browser.browserLog.value).toEqual([])
  })

  it('reports failed actions and restores status after a successful retry', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/act') && fail ? { result: { error: 'failed' } } : { result: {} }))))
    const browser = mountBrowser()
    await browser.browserGoBack()
    expect(browser.browserLog.value.at(-1)).toBe('后退失败')
    expect(browser.browserStatus.value).toBe('动作失败')
    fail = false
    await browser.browserGoBack()
    expect(browser.browserStatus.value).toBe('实时')
    expect(browser.browserFailHint.value).toBe('')
  })

  it('ignores a navigation response from a session that was switched away from', async () => {
    let finish!: (r: Response) => void
    vi.stubGlobal('fetch', vi.fn((url: string) => url.endsWith('/navigate')
      ? new Promise<Response>((resolve) => { finish = resolve })
      : Promise.resolve(new Response('{}'))))
    const sid = ref('session-a')
    const browser = mountBrowser(() => sid.value)
    browser.browserUrlInput.value = 'https://old.test'
    const pending = browser.goToUrl()
    sid.value = 'session-b'
    sid.value = 'session-a'
    finish(new Response(JSON.stringify({ url: 'https://old.test' })))
    await pending
    expect(browser.browserUrl.value).toBe('')
    expect(browser.browserStatus.value).toBe('待机')
    expect(browser.browserLoading.value).toBe(false)
  })

  it('does not send Enter to the new session when typing finishes after switching', async () => {
    let finish!: (r: Response) => void
    const fetchMock = vi.fn((url: string) => url.endsWith('/act')
      ? new Promise<Response>((resolve) => { finish = resolve })
      : Promise.resolve(new Response('{}')))
    vi.stubGlobal('fetch', fetchMock)
    const sid = ref('session-a')
    const browser = mountBrowser(() => sid.value)
    browser.browserTypeText.value = 'query'
    const pending = browser.doType(true)
    sid.value = 'session-b'
    finish(new Response(JSON.stringify({ result: {} })))
    await pending
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/act'))).toHaveLength(1)
    expect(browser.browserTypeText.value).toBe('query')
  })

  it('shows a refresh error returned in a successful HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/refresh') ? { error: 'page closed' } : {}))))
    const browser = mountBrowser()
    await browser.refreshPage()
    expect(browser.browserStatus.value).toBe('失败')
    expect(browser.browserFailHint.value).toContain('page closed')
  })

  it('clears a selected field when its index is reused for a different element', async () => {
    let label = 'First field'
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/navigate')
      ? { url: 'https://example.test', dom: { text: '', elements: [{ i: 1, tag: 'input', type: 'text', text: label }] } }
      : { result: {} })))
    vi.stubGlobal('fetch', fetchMock)
    const browser = mountBrowser()
    browser.browserUrlInput.value = 'https://example.test'
    await browser.goToUrl()
    browser.browserDomMode.value = true
    browser.focusElem(1)
    label = 'Different field'
    await browser.goToUrl()
    browser.browserTypeText.value = 'keep this'
    await browser.doType(false)
    expect(browser.domFocusIndex.value).toBe(-1)
    expect(browser.browserTypeText.value).toBe('keep this')
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/act'))).toBe(false)
  })

  it('does not include typed content in the operation log', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: {} }))))
    const browser = mountBrowser()
    browser.browserTypeText.value = 'private input content'
    await browser.doType(false)
    expect(browser.browserLog.value.join(' ')).not.toContain('private input content')
  })

  it('does not press Enter or discard text when typing failed', async () => {
    const actions: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/act')) return new Response('{}')
      actions.push(JSON.parse(String(init?.body)).action)
      return new Response(JSON.stringify({ result: { error: 'type failed' } }))
    }))
    const browser = mountBrowser()
    browser.browserTypeText.value = 'query'
    await browser.doType(true)
    expect(actions).toEqual(['type'])
    expect(browser.browserTypeText.value).toBe('query')
  })

  it('preserves text for retry when click-by-text fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/act') ? { result: { error: 'not found' } } : {}))))
    const browser = mountBrowser()
    browser.browserClickText.value = 'Find me'
    await browser.doClickText()
    expect(browser.browserClickText.value).toBe('Find me')
    expect(browser.browserFailHint.value).toBe('not found')
  })

  it('does not leave already typed text in the input when Enter fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const action = init?.body ? JSON.parse(String(init.body)).action : ''
      return new Response(JSON.stringify(url.endsWith('/act') && action === 'key' ? { result: { error: 'enter failed' } } : { result: {} }))
    }))
    const browser = mountBrowser()
    browser.browserTypeText.value = 'already typed'
    await browser.doType(true)
    expect(browser.browserTypeText.value).toBe('')
    expect(browser.browserFailHint.value).toBe('enter failed')
  })

  it('clears old view without closing a browser used by the previous task', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const sid = ref('session-a')
    const browser = mountBrowser(() => sid.value)
    browser.browserUrl.value = 'https://example.test'
    browser.browserDom.value = { text: 'previous page', elements: [] }
    sid.value = 'session-b'
    await nextTick()
    expect(browser.browserUrl.value).toBe('')
    expect(browser.browserDom.value).toBeNull()
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/close'))).toBe(false)
  })

  it('backs off failed frame polling instead of spinning', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (url: string) => url.includes('/latest') ? new Response('', { status: 503 }) : new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    mountBrowser(() => 'session-a', () => true)
    await vi.advanceTimersByTimeAsync(100)
    const polls = () => fetchMock.mock.calls.filter((call) => String(call[0]).includes('/latest')).length
    expect(polls()).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(polls()).toBe(2)
    app?.unmount()
    app = undefined
    await vi.advanceTimersByTimeAsync(20_000)
    expect(polls()).toBe(2)
  })
})
