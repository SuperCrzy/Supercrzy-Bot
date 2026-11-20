import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
await p.addInitScript(() => {
  window.supercrzyDesktop = { isDesktop: true, platform: 'win32', onBackendStatus: (cb) => cb({ status: 'ready' }), app: { getInfo: async () => ({ version: '1.3.3', packaged: true }) } }
})
await p.goto('http://127.0.0.1:5173/?preview=1', { waitUntil: 'domcontentloaded', timeout: 45000 })
await p.waitForTimeout(6000)
const r = await p.evaluate(() => {
  const q = (s) => document.querySelector(s)
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) } }
  const bar = q('.traffic-spacer')
  return {
    url: location.href,
    bar: box(bar),
    toggle: box(q('.menu-toggle-btn')),
    menus: Array.from(document.querySelectorAll('.menu-item-btn')).map(el => ({ t: el.textContent.trim(), ...box(el) })),
    title: box(q('.traffic-workspace-zone')),
    sidebarHeader: box(q('.sidebar-header')),
  }
})
console.log(JSON.stringify(r, null, 1))
await b.close()
