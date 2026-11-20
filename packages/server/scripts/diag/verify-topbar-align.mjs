import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
await p.addInitScript(() => {
  window.supercrzyDesktop = { isDesktop: true, platform: 'win32', onBackendStatus: (cb) => cb({ status: 'ready' }), app: { getInfo: async () => ({ version: '1.3.4', packaged: true }) } }
})
await p.goto('http://127.0.0.1:5173/?preview=1', { waitUntil: 'domcontentloaded', timeout: 45000 })
await p.waitForTimeout(5500)
const r = await p.evaluate(() => {
  const bx = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) } }
  const nav = document.querySelector('.nav-item')
  return {
    logo: bx(document.querySelector('.sidebar-header .logo-icon')),
    navIcon: bx(nav?.querySelector('svg')),
    navText: bx(nav?.querySelector('span')),
    navBox: bx(nav),
    menuIcon: bx(document.querySelector('.menu-toggle-btn svg')),
    menuText: bx(document.querySelector('.menu-item-btn')),
  }
})
console.log(JSON.stringify(r, null, 1))
const li = r.logo?.x, ni = r.navIcon?.x
console.log(`\nlogo x=${li}, nav icon x=${ni} -> ${li === ni ? 'ALIGNED' : 'diff ' + (li - ni)}`)
await p.screenshot({ path: '/tmp/ui-after.png', clip: { x: 0, y: 0, width: 420, height: 260 } })
await b.close()
