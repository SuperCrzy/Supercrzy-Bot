// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { expect, it } from 'vitest'
import SourceCards from './SourceCards.vue'

it('only lists links in prose, not URLs in code or images', async () => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const text = '[文档](https://docs.example/a) https://news.example/article\n\n`https://inline.example`\n\n```sh\ncurl https://code.example\n```\n\n![图](https://img.example/a.png)'
  const app = createApp({ render: () => h(SourceCards, { text }) })
  app.use(createI18n({ legacy: false, locale: 'zh', messages: { zh: { chatui: { sources: '相关链接' } } } }))
  try {
    app.mount(root)
    await nextTick()
    expect(Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(['https://docs.example/a', 'https://news.example/article'])
  } finally { app.unmount(); root.remove() }
})
