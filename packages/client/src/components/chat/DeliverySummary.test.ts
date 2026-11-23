// @vitest-environment jsdom
import { createApp, h, nextTick, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import { expect, it, vi } from 'vitest'
import type { ChatMessage } from '@/types'
import DeliverySummary from './DeliverySummary.vue'

it('shows task details and expands and collapses a long artifact list', async () => {
  const msg = reactive({ id: 'm', role: 'assistant', content: '', createdAt: '2026-01-01', deliverySummary: {
    status: 'cancelled', summary: '已停止', artifactCount: 5,
    artifacts: Array.from({ length: 5 }, (_, i) => ({ name: `file${i}.txt`, path: `/file${i}.txt`, mime: 'text/plain' })),
    changedFiles: [{ name: 'app.ts', path: '/app.ts' }], toolCallCount: 2, turns: 1, cost: 0.0123, checkpointId: 'ckpt', canResume: true,
  } } as ChatMessage)
  const root = document.createElement('div'); document.body.appendChild(root)
  const app = createApp({ render: () => h(DeliverySummary, { msg }) })
  app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: { chat: { deliveryCancelled: '已取消', deliveryTitle: '产物', artifactOpen: '打开', deliveryMore: '展开剩余 {n} 个', deliveryChanges: '改动 {n}', deliveryTurns: '{n} 轮', deliveryTools: '{n} 次工具', deliveryResume: '继续' }, chatui: { webFetchCollapse: '收起' } } } }))
  const open = vi.spyOn(window, 'open').mockImplementation(() => null)
  try {
    app.mount(root); await nextTick()
    expect(root.textContent).toContain('已停止')
    expect(root.textContent).toContain('app.ts')
    expect(root.textContent).toContain('≈ ¥0.0123')
    expect(root.textContent).toContain('ckpt')
    expect(root.querySelectorAll('.ds-card')).toHaveLength(3)
    expect(root.textContent).toContain('展开剩余 2 个')
    ;(root.querySelector('.ds-more') as HTMLElement).click(); await nextTick()
    expect(root.querySelectorAll('.ds-card')).toHaveLength(5)
    ;(root.querySelector('.ds-card-open') as HTMLButtonElement).click()
    expect(open).toHaveBeenCalledWith('/api/workspace/file?path=%2Ffile0.txt', '_blank')
    ;(root.querySelector('.ds-more') as HTMLElement).click(); await nextTick()
    expect(root.querySelectorAll('.ds-card')).toHaveLength(3)
  } finally { open.mockRestore(); app.unmount(); root.remove() }
})
