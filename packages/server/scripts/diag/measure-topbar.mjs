import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
// Pretend to be the Electron shell so the desktop top bar renders.
await p.addInitScript(() => {
  window.supercrzyDesktop = {
    isDesktop: true, platform: 'win32',
    onBackendStatus: (cb) => cb({ status: 'ready' }),
    getInfo: async () => ({ version: '1.3.3', packaged: true, platform: 'win32' }),
    app: { getInfo: async () => ({ version: '1.3.3', packaged: true, platform: 'win32' }) },
  }
})
await p.goto('http://127.0.0.1:5173/?preview=1', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
await p.waitForTimeout(3000)
await p.goto('http://127.0.0.1:5173/chat?preview=1', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
await p.waitForTimeout(3000)
const r = await p.evaluate(() => {
  const q = (s) => document.querySelector(s)
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) } }
  const bar = q('.traffic-spacer')
  return {
    bar: box(bar),
    barClasses: bar?.className || '',
    zone: box(q('.traffic-sidebar-zone')),
    toggle: box(q('.menu-toggle-btn')),
    menus: Array.from(document.querySelectorAll('.menu-item-btn')).map(el => ({ t: el.textContent.trim(), ...box(el) })),
    titleZone: box(q('.traffic-workspace-zone')),
    sidebarHeader: box(q('.sidebar-header')),
    logo: box(q('.sidebar-header .logo-icon')),
  }
})
console.log(JSON.stringify(r, null, 2))
await p.screenshot({ path: '/tmp/topbar-expanded.png', clip: { x: 0, y: 0, width: 1400, height: 200 } })
await p.click('.menu-toggle-btn')
await p.waitForTimeout(700)
const r2 = await p.evaluate(() => {
  const q = (s) => document.querySelector(s)
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) } }
  return { toggle: box(q('.menu-toggle-btn')), menus: document.querySelectorAll('.menu-item-btn').length, titleZone: box(q('.traffic-workspace-zone')) }
})
console.log('COLLAPSED:', JSON.stringify(r2))
await p.screenshot({ path: '/tmp/topbar-collapsed.png', clip: { x: 0, y: 0, width: 1400, height: 200 } })
await b.close()
