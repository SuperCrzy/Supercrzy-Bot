import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] })
for (const [lang, loc] of [['zh', 'zh-CN'], ['en', 'en-US']]) {
  for (const idx of [0, 1, 2]) {
    const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
    await p.addInitScript(({ l, plat }) => {
      localStorage.setItem('supercrzy-lang', l)
      window.supercrzyDesktop = { isDesktop: true, platform: plat, onBackendStatus: (cb) => cb({ status: 'ready' }), app: { getInfo: async () => ({ version: '1.3.3', packaged: true }) } }
    }, { l: loc, plat: 'win32' })
    await p.goto('http://127.0.0.1:5173/?preview=1', { waitUntil: 'domcontentloaded', timeout: 45000 })
    await p.waitForTimeout(4500)
    const btns = await p.$$('.menu-item-btn')
    await btns[idx].click()
    await p.waitForTimeout(400)
    const r = await p.evaluate(() => ({
      labels: Array.from(document.querySelectorAll('.app-menu-label')).map(e => e.textContent.trim()),
      shortcuts: Array.from(document.querySelectorAll('.app-menu-shortcut')).map(e => e.textContent.trim()),
      dividers: document.querySelectorAll('.app-menu-divider').length,
      panelBox: (() => { const p = document.querySelector('.app-menu-panel'); if (!p) return null; const b = p.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width) } })(),
    }))
    console.log(`${lang.toUpperCase()} menu#${idx}:`, JSON.stringify(r))
    await p.close()
  }
}
await b.close()
