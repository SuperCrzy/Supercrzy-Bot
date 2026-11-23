// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { expect, it } from 'vitest'
import MessageFlowRenderer from './MessageFlowRenderer.vue'

it('keeps consecutive source links visible while a reply is streaming', async () => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const msg = { id: 'reply', role: 'assistant', content: '', createdAt: new Date().toISOString(), flow: [{ id: 'text', kind: 'text', text: '[来源一](https://one.example) [来源二](https://two.example)' }] }
  const app = createApp({ render: () => h(MessageFlowRenderer, { msg: msg as any, isLoading: true, isLastMessage: true, showReasoning: false, permission: 'sandbox', autoApproveSeconds: 0 }) })
  app.use(createPinia())
  app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: {} }, missingWarn: false, fallbackWarn: false }))
  try {
    app.mount(root)
    await nextTick()
    expect(Array.from(root.querySelectorAll('.message-content a')).map((a) => a.textContent)).toEqual(['来源一', '来源二'])
  } finally { app.unmount(); root.remove() }
})

it('keeps ordinary XML code in a streamed reply', async () => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const msg = { id: 'xml', role: 'assistant', content: '', createdAt: new Date().toISOString(), flow: [{ id: 'text', kind: 'text', text: '```xml\n<settings><theme>dark</theme></settings>\n```' }] }
  const app = createApp({ render: () => h(MessageFlowRenderer, { msg: msg as any, isLoading: true, isLastMessage: true, showReasoning: false, permission: 'sandbox', autoApproveSeconds: 0 }) })
  app.use(createPinia())
  app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: {} }, missingWarn: false, fallbackWarn: false }))
  try {
    app.mount(root)
    await nextTick()
    expect(root.querySelector('.message-content code')?.textContent).toContain('<settings><theme>dark</theme></settings>')
  } finally { app.unmount(); root.remove() }
})

it('does not render structured comparison JSON as ordinary message text when the parent displays it', async () => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const msg = { id: 'compare', role: 'assistant', content: '{"results":[]}', createdAt: new Date().toISOString() }
  const app = createApp({ render: () => h(MessageFlowRenderer, { msg: msg as any, suppressContent: true, isLoading: false, isLastMessage: true, showReasoning: false, permission: 'sandbox', autoApproveSeconds: 0 }) })
  app.use(createPinia())
  app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: {} }, missingWarn: false, fallbackWarn: false }))
  try {
    app.mount(root)
    await nextTick()
    expect(root.querySelector('.message-content')).toBeNull()
  } finally { app.unmount(); root.remove() }
})

it('shows an interruption notice alongside a partial answer', async () => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const msg = { id: 'interrupted', role: 'assistant', content: '已收到的部分回答', createdAt: new Date().toISOString(), stopReason: { reason: 'connection_interrupted', message: '连接中断，请检查任务状态' } }
  const app = createApp({ render: () => h(MessageFlowRenderer, { msg: msg as any, isLoading: false, isLastMessage: true, showReasoning: false, permission: 'sandbox', autoApproveSeconds: 0 }) })
  app.use(createPinia())
  app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: {} }, missingWarn: false, fallbackWarn: false }))
  try {
    app.mount(root)
    await nextTick()
    expect(root.querySelector('.message-content')?.textContent).toContain('已收到的部分回答')
    expect(root.querySelector('.stop-reason-banner')?.textContent).toContain('连接中断')
  } finally { app.unmount(); root.remove() }
})
