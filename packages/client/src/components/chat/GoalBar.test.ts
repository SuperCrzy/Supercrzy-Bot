// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type Ref } from 'vue'
import GoalBar from './GoalBar.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key, locale: { value: 'zh' } }) }))
vi.mock('@/stores/account', () => ({ useAccountStore: () => ({ accountId: 'account' }) }))
vi.mock('@/stores/app', () => ({ useAppStore: () => ({ currentModel: 'selected-model' }) }))

const goal = (id: string) => ({ id, objective: id, acceptance: '', status: 'active', version: 1, elapsed_ms: 0, running_since: null, last_result: '' })
let unmount: (() => void) | undefined
afterEach(() => { unmount?.(); unmount = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals() })

function mount(session: Ref<string>) {
  const root = document.createElement('div'); document.body.append(root)
  const app = createApp({ render: () => h(GoalBar, { sessionId: session.value }) })
  app.config.globalProperties.$t = (key: string) => key
  app.mount(root)
  unmount = () => app.unmount()
  return root
}

describe('goal progress display', () => {
  it('preserves a question reply when the answer request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/question-answer')) return new Response('', { status: 500 })
      if (url.endsWith('/pending')) return Response.json({ questions: [{ id: 'q', question: 'Question' }], confirmations: [] })
      if (url.includes('/events?')) return Response.json({ events: [] })
      return Response.json({ goal: goal('a') })
    }))
    const root = mount(ref('a'))
    await vi.waitFor(() => expect(root.querySelector('.goal-pending input')).not.toBeNull())
    const input = root.querySelector('.goal-pending input') as HTMLInputElement
    input.value = 'keep my answer'; input.dispatchEvent(new Event('input')); await nextTick()
    root.querySelector('.goal-pending form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(root.textContent).toContain('goal.actionError'))
    expect(input.value).toBe('keep my answer')
  })
  it('does not save an old draft into a replacement goal', async () => {
    let current = { ...goal('a'), status: 'paused' }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/pending')) return Response.json({ questions: [], confirmations: [] })
      if (url.includes('/events?')) return Response.json({ events: [] })
      return Response.json({ goal: current })
    })
    vi.stubGlobal('fetch', fetchMock)
    const root = mount(ref('session'))
    await vi.waitFor(() => expect(root.querySelector('.goal-summary')).not.toBeNull())
    ;(root.querySelector('.goal-summary') as HTMLButtonElement).click(); await nextTick()
    ;([...root.querySelectorAll('button')].find(item => item.textContent?.includes('goal.edit')) as HTMLButtonElement).click(); await nextTick()
    const input = root.querySelector('#goal-edit-objective') as HTMLTextAreaElement
    input.value = 'unsaved draft'; input.dispatchEvent(new Event('input'))
    current = { ...goal('replacement'), status: 'paused' }
    await vi.waitFor(() => expect(root.querySelector('.goal-text')?.textContent).toBe('replacement'), { timeout: 3000 })
    expect(input.value).toBe('unsaved draft')
    expect(root.textContent).toContain('goal.editChanged')
    expect(([...root.querySelectorAll('button')].find(item => item.textContent?.includes('goal.save')) as HTMLButtonElement).disabled).toBe(true)
  })
  it('edits a stopped goal using the version displayed when editing began', async () => {
    let current = { ...goal('a'), status: 'paused', acceptance: 'old' }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/edit')) { const data = JSON.parse(String(init?.body)); current = { ...current, objective: data.objective, acceptance: data.acceptance, version: 2 }; return Response.json({ ok: true }) }
      if (url.endsWith('/pending')) return Response.json({ questions: [], confirmations: [] })
      if (url.includes('/events?')) return Response.json({ events: [] })
      return Response.json({ goal: current })
    })
    vi.stubGlobal('fetch', fetchMock)
    const root = mount(ref('a'))
    await vi.waitFor(() => expect(root.querySelector('.goal-summary')).not.toBeNull())
    ;(root.querySelector('.goal-summary') as HTMLButtonElement).click(); await nextTick()
    ;([...root.querySelectorAll('button')].find(item => item.textContent?.includes('goal.edit')) as HTMLButtonElement).click(); await nextTick()
    const input = root.querySelector('#goal-edit-objective') as HTMLTextAreaElement
    input.value = 'new goal'; input.dispatchEvent(new Event('input')); await nextTick()
    ;([...root.querySelectorAll('button')].find(item => item.textContent?.includes('goal.save')) as HTMLButtonElement).click()
    await vi.waitFor(() => expect(root.querySelector('.goal-text')?.textContent).toBe('new goal'))
    const post = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/edit'))!
    expect(JSON.parse(String(post[1]?.body))).toMatchObject({ version: 1, objective: 'new goal', acceptance: 'old' })
  })
  it('starts with the currently selected model and interface language', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'POST') return Response.json({ ok: true })
      if (url.endsWith('/pending')) return Response.json({ questions: [], confirmations: [] })
      if (url.includes('/events?')) return Response.json({ events: [] })
      return Response.json({ goal: { ...goal('a'), status: 'paused' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const root = mount(ref('a'))
    await vi.waitFor(() => expect(root.textContent).toContain('goal.start'))
    const button = [...root.querySelectorAll('button')].find(item => item.textContent?.includes('goal.start'))!
    button.click()
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!
    expect(JSON.parse(String(post[1]?.body))).toMatchObject({ model: 'selected-model', language: 'zh' })
  })
  it('catches up with more than five pages without waiting for the polling interval', async () => {
    const cursors: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/pending')) return Response.json({ questions: [], confirmations: [] })
      if (url.includes('/events?')) {
        const after = Number(new URL(url, 'http://local').searchParams.get('after')); cursors.push(after)
        return Response.json({ events: Array.from({ length: Math.min(100, 605 - after) }, (_, i) => ({ sequence: after + i + 1, run_id: 'run', event: 'content_chunk', payload: { text: after + i === 604 ? 'LATEST' : '.' } })) })
      }
      return Response.json({ goal: goal('a') })
    }))
    const root = mount(ref('a'))
    await vi.waitFor(() => expect(root.querySelector('.goal-summary')).not.toBeNull())
    ;(root.querySelector('.goal-summary') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(root.querySelector('.goal-output')?.textContent).toContain('LATEST'))
    expect(cursors).toEqual([0, 100, 200, 300, 400, 500, 600])
  })

  it('ignores a late response after switching sessions', async () => {
    let finishOld!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/sessions/a/goal') return new Promise<Response>(resolve => { finishOld = resolve })
      if (url.endsWith('/pending')) return Promise.resolve(Response.json({ questions: [], confirmations: [] }))
      if (url.includes('/events?')) return Promise.resolve(Response.json({ events: [] }))
      return Promise.resolve(Response.json({ goal: goal('b') }))
    }))
    const session = ref('a'), root = mount(session)
    await vi.waitFor(() => expect(finishOld).toBeTypeOf('function'))
    session.value = 'b'; await nextTick()
    await vi.waitFor(() => expect(root.querySelector('.goal-text')?.textContent).toBe('b'))
    finishOld(Response.json({ goal: goal('a') }))
    await nextTick(); await nextTick()
    expect(root.querySelector('.goal-text')?.textContent).toBe('b')
  })
})
