// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { expect, it, vi } from 'vitest'
import ChatStatusNotices from './ChatStatusNotices.vue'

it('shows the correct notices and emits each retry action', async () => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const retrySave = vi.fn(), retryHistory = vi.fn()
  const app = createApp({ render: () => h(ChatStatusNotices, { sending: false, unsaved: true, historyState: 'error', onRetrySave: retrySave, onRetryHistory: retryHistory }) })
  app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: { chat: { messageSaveFailed: '保存失败', historyLoadFailed: '历史加载失败' }, common: { refresh: '刷新' } } } }))
  try {
    app.mount(root)
    await nextTick()
    expect(root.textContent).toContain('保存失败')
    expect(root.textContent).toContain('历史加载失败')
    const buttons = root.querySelectorAll('button')
    buttons[0].click(); buttons[1].click()
    expect(retrySave).toHaveBeenCalledOnce()
    expect(retryHistory).toHaveBeenCalledOnce()
  } finally { app.unmount(); root.remove() }
})
