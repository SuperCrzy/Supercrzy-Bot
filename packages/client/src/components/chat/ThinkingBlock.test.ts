// @vitest-environment jsdom
import { createApp, h, nextTick, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import { expect, it } from 'vitest'
import { useReasoningDisplay } from '@/utils/reasoning-display'
import ThinkingBlock from './ThinkingBlock.vue'

it('keeps the user-selected live state while reasoning and preferences change', async () => {
  const preference = useReasoningDisplay()
  preference.setLiveExpanded(false)
  const state = reactive({ message: '', completed: false, reasoning: '第一段推理' })
  const root = document.createElement('div'); document.body.appendChild(root)
  const app = createApp({ render: () => h(ThinkingBlock, state) })
  app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: { chatui: { deepThinking: '深度思考' } } } }))
  try {
    app.mount(root); await nextTick()
    expect(root.querySelector('.thinking-reasoning.live')).toBeNull()
    preference.setLiveExpanded(true)
    state.reasoning = '第一段推理\n第二段推理'; await nextTick()
    expect(root.querySelector('.thinking-reasoning.live')).toBeNull()
    ;(root.querySelector('.thinking-header') as HTMLElement).click(); await nextTick()
    expect(root.querySelector('.thinking-reasoning.live')).not.toBeNull()
    preference.setLiveExpanded(false)
    state.reasoning += '\n第三段推理'; await nextTick()
    expect(root.querySelector('.thinking-reasoning.live')).not.toBeNull()
    state.completed = true; await nextTick()
    expect(root.querySelector('.thinking-reasoning')).toBeNull()
  } finally { app.unmount(); root.remove(); preference.setLiveExpanded(false) }
})
