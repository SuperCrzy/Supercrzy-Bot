// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { usePlanStore } from '@/stores/plan'
import PlanCapsule from './PlanCapsule.vue'

vi.mock('@/stores/chat', () => ({ useChatStore: () => ({ currentSessionId: null }) }))

describe('plan capsule outcome', () => {
  afterEach(() => { document.body.innerHTML = '' })
  it('shows an incomplete task after interruption, then resets for a new plan', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const plan = usePlanStore()
    const el = document.createElement('div')
    document.body.appendChild(el)
    const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: { chat: { planInterrupted: '任务未完成', planFinalizing: '收尾中…', planAllDone: '全部完成' } } } })
    const app = createApp(PlanCapsule).use(pinia).use(i18n)
    app.mount(el)
    plan.setPlanUpdate({ planId: 'one', title: 'Task', steps: [{ id: 'step', subject: 'Check', status: 'completed' }] })
    await nextTick()
    expect(el.textContent).toContain('收尾中…')
    plan.markPlanFinished(false)
    await nextTick()
    expect(el.textContent).toContain('任务未完成')
    expect(el.textContent).not.toContain('全部完成')
    plan.setPlanUpdate({ planId: 'two', title: 'Next', steps: [{ id: 'step2', subject: 'Next step', status: 'in_progress' }] })
    await nextTick()
    await vi.waitFor(() => expect(el.textContent).toContain('Next step'))
    app.unmount()
  })
})
