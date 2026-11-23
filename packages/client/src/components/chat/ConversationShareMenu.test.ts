// @vitest-environment jsdom
import { createApp, h, nextTick, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import { expect, it, vi } from 'vitest'
import ConversationShareMenu from './ConversationShareMenu.vue'

it('teleports the menu and emits all actions and backdrop close', async () => {
  const state = reactive({ open: true })
  const copy = vi.fn(), download = vi.fn(), image = vi.fn(), close = vi.fn()
  const root = document.createElement('div'); document.body.appendChild(root)
  const app = createApp({ render: () => h(ConversationShareMenu, { open: state.open, onCopy: copy, onDownload: download, onImage: image, onClose: close }) })
  app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: { chat: { shareCopyMd: '复制', shareDownloadMd: '下载', shareImage: '分享图片' } } } }))
  try {
    app.mount(root); await nextTick()
    const overlay = document.body.querySelector('.share-overlay') as HTMLElement
    expect(overlay).not.toBeNull()
    const buttons = overlay.querySelectorAll('button')
    buttons[0].click(); buttons[1].click(); buttons[2].click(); overlay.click()
    expect(copy).toHaveBeenCalledOnce(); expect(download).toHaveBeenCalledOnce()
    expect(image).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
    state.open = false; await nextTick()
    expect(document.body.querySelector('.share-overlay')).toBeNull()
  } finally { app.unmount(); root.remove() }
})
