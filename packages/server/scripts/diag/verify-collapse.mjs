import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] })
for (const plat of ['win32', 'darwin']) {
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
  await p.addInitScript((platform) => {
    window.supercrzyDesktop = { isDesktop: true, platform, onBackendStatus: (cb) => cb({ status: 'ready' }), app: { getInfo: async () => ({ version: '1.3.3', packaged: true, platform }) } }
  }, plat)
  await p.goto('http://127.0.0.1:5173/?preview=1', { waitUntil: 'domcontentloaded', timeout: 45000 })
  await p.waitForTimeout(5000)
  const read = async () => p.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const bx = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), r: Math.round(b.right), w: Math.round(b.width) } }
    const bar = q('.traffic-spacer')
    const zone = q('.traffic-sidebar-zone')
    const menus = Array.from(document.querySelectorAll('.menu-item-btn')).map(e => ({ t: e.textContent.trim(), ...bx(e) }))
    return {
      barH: bar ? Math.round(bar.getBoundingClientRect().height) : null,
      isWin: bar?.classList.contains('traffic-spacer--win') ?? null,
      zone: bx(zone), zoneOverflow: zone ? Math.round(zone.getBoundingClientRect().right) : null,
      menus, lastMenuRight: menus.length ? menus[menus.length - 1].r : null,
      title: bx(q('.traffic-workspace-zone')),
    }
  })
  const open = await read()
  console.log(`\n=== ${plat} EXPANDED ===`)
  console.log(JSON.stringify(open))
  if (open.lastMenuRight != null && open.title) {
    console.log(`overlap: ${open.lastMenuRight > open.title.x ? 'YES' : 'no'} (menu ends ${open.lastMenuRight}, title starts ${open.title.x})`)
  }
  await p.click('.menu-toggle-btn')
  await p.waitForTimeout(600)
  const col = await read()
  console.log(`=== ${plat} COLLAPSED ===`)
  console.log(JSON.stringify(col))
  console.log(`menu count collapsed: ${col.menus.length} (expect 0)`)
  await p.close()
}
await b.close()
