// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type Ref } from 'vue'
import GoalBar from './GoalBar.vue'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/stores/account', () => ({ useAccountStore: () => ({ accountId: 'account' }) }))

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
