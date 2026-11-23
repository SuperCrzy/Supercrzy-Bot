// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { useSessionArtifacts } from './useSessionArtifacts'

const apps: Array<ReturnType<typeof createApp>> = []
afterEach(() => { for (const app of apps.splice(0)) app.unmount(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

describe('session artifact list', () => {
  it('does not reveal an old session folder after switching during a refresh', async () => {
    let finishRefresh!: (response: Response) => void
    let calls = 0
    const sid = ref('old')
    const openDir = vi.fn()
    const fetchMock = vi.fn((_input: RequestInfo | URL) => {
      calls++
      if (calls === 2) return new Promise<Response>((resolve) => { finishRefresh = resolve })
      return Promise.resolve(new Response('[]'))
    })
    vi.stubGlobal('fetch', fetchMock)
    let result!: ReturnType<typeof useSessionArtifacts>
    const component = defineComponent({ setup() {
      result = useSessionArtifacts({ sessionId: () => sid.value, visible: () => false, activeTab: () => '', messages: () => [], preview: () => {}, openDir })
      return () => h('div')
    } })
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(component)
    apps.push(app)
    app.mount(root)
    result.openArtifactMenu(new MouseEvent('contextmenu'), { path: '/old.txt', name: 'old.txt' })
    const pending = result.menuRevealArtifact()
    sid.value = 'new'
    finishRefresh(new Response('[]'))
    await pending
    expect(openDir).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/open'))).toBe(false)
  })

  it('ignores an older session response and offers retry after a failed refresh', async () => {
    let finishOld!: (response: Response) => void
    const sid = ref('old')
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/old/')) return new Promise<Response>((resolve) => { finishOld = resolve })
      return Promise.resolve(new Response(JSON.stringify([{ id: 'new-id', name: 'new.txt', path: '/new.txt' }])))
    }))
    let result!: ReturnType<typeof useSessionArtifacts>
    const component = defineComponent({ setup() {
      result = useSessionArtifacts({ sessionId: () => sid.value, visible: () => false, activeTab: () => '', messages: () => [], preview: () => {}, openDir: () => {} })
      return () => h('div')
    } })
    const root = document.createElement('div')
    document.body.appendChild(root)
    const app = createApp(component)
    apps.push(app)
    app.mount(root)
    sid.value = 'new'
    await nextTick()
    await vi.waitFor(() => expect(result.artifactFiles.value[0]?.name).toBe('new.txt'))
    finishOld(new Response(JSON.stringify([{ name: 'old.txt', path: '/old.txt' }])))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.artifactFiles.value.map((item) => item.name)).toEqual(['new.txt'])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await result.loadSessionArtifacts()
    expect(result.loadError.value).toBe(true)
    expect(result.artifactFiles.value[0].name).toBe('new.txt')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    await result.loadSessionArtifacts()
    expect(result.loadError.value).toBe(false)
    expect(result.artifactFiles.value).toEqual([])
  })
})
