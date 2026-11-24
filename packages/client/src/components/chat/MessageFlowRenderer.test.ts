// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { expect, it } from 'vitest'
import MessageFlowRenderer from './MessageFlowRenderer.vue'

// Reply-structure template tests (2026-11-24): narration stays visible in the
// completed state, and each process segment gets its own summary row instead of
// one merged mega-bar.
const TEMPLATE_I18N = createI18n({
  legacy: false,
  locale: 'zh',
  messages: { zh: { chat: { turnCompleted: '已完成', stageCount: '{stage} {n}', stageReading: '读取', stageExecuting: '执行' } } },
  missingWarn: false,
  fallbackWarn: false,
})

function toolNode(id: string, name: string) {
  return { id, kind: 'tool', tool: { id, name, arguments: '{}', status: 'done', duration: 1 } }
}

function mountMsg(root: HTMLElement, flow: unknown[]) {
  const msg = { id: 'reply', role: 'assistant', content: 'final answer', createdAt: new Date().toISOString(), flow: flow as any }
  const app = createApp({ render: () => h(MessageFlowRenderer, { msg: msg as any, isLoading: false, isLastMessage: true, showReasoning: false, permission: 'sandbox', autoApproveSeconds: 0 }) })
  app.use(createPinia())
  app.use(TEMPLATE_I18N)
  app.mount(root)
  return app
}

it('completed turn keeps narration visible and collapses tools into one summary row per segment', async () => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const flow = [
    { id: 'n1', kind: 'text', text: '先跑全量回归，若有失败会追到根因。' },
    toolNode('t1', 'file_read'),
    { id: 'n3', kind: 'text', text: '回归通过，接下来核对前端门禁。' },
    toolNode('t2', 'shell_exec'),
    { id: 'n5', kind: 'text', text: '**全量回归已完成：** 1359 项通过。' },
  ]
  const app = mountMsg(root, flow)
  try {
    await nextTick()
    const texts = Array.from(root.querySelectorAll('.message-content'))
    expect(texts).toHaveLength(3)
    expect(texts[0].textContent).toContain('先跑全量回归')
    expect(texts[2].textContent).toContain('全量回归已完成')
    const bars = Array.from(root.querySelectorAll('.process-collapse-bar'))
    expect(bars).toHaveLength(2)
    expect(bars[0].textContent).toContain('已完成')
    expect(bars[0].textContent).toContain('读取 1')
    expect(bars[1].textContent).toContain('执行 1')
  } finally { app.unmount(); root.remove() }
})

it('long turn keeps one summary row per process segment instead of merging them into a single bar', async () => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const toolsA = Array.from({ length: 5 }, (_, i) => toolNode(`a${i}`, 'file_read'))
  const toolsB = Array.from({ length: 5 }, (_, i) => toolNode(`b${i}`, 'shell_exec'))
  const flow = [
    { id: 'n1', kind: 'text', text: 'opening narration' },
    ...toolsA,
    { id: 'n7', kind: 'text', text: 'mid narration' },
    ...toolsB,
    { id: 'n13', kind: 'text', text: 'final answer' },
  ]
  const app = mountMsg(root, flow)
  try {
    await nextTick()
    expect(root.querySelectorAll('.message-content')).toHaveLength(3)
    const bars = Array.from(root.querySelectorAll('.process-collapse-bar'))
    expect(bars).toHaveLength(2)
  } finally { app.unmount(); root.remove() }
})

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
