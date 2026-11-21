/**
 * Measures the sidebar header against the nav column across the four states
 * that actually differ: Windows/macOS x expanded/collapsed. Numbers only —
 * "looks fine" is not a measurement.
 */
import { chromium } from 'playwright-core'

const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
})

for (const plat of ['win32', 'darwin']) {
  for (const collapsed of [false, true]) {
    const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
    await p.addInitScript(([pl, col]) => {
      window.supercrzyDesktop = {
        isDesktop: true, platform: pl,
        onBackendStatus: (cb) => cb({ status: 'ready' }),
        app: { getInfo: async () => ({ version: '1.3.4', packaged: true, platform: pl }) },
      }

    }, [plat, collapsed])
    await p.goto('http://localhost:5174/?preview=1', { waitUntil: 'domcontentloaded', timeout: 45000 })
    await p.waitForTimeout(5000)
    // Collapse is component state, not a persisted key, so click the toggle.
    if (collapsed) {
      await p.waitForSelector('.menu-toggle-btn', { state: 'visible', timeout: 10000 })
      // Synthetic click: Playwright's coordinate click does not register on the
      // custom title bar here, which is irrelevant to what this measures.
      await p.evaluate(() => (document.querySelector('.menu-toggle-btn')).click())
      // The click flips component state; poll until the attribute reflects it
      // instead of trusting a fixed sleep.
      await p.waitForFunction(
        () => document.querySelector('.traffic-sidebar-zone')?.getAttribute('data-collapsed') === 'true',
        { timeout: 5000 },
      ).catch(() => {})
    }

    const r = await p.evaluate(() => {
      const bx = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); if (b.width === 0 && b.height === 0) return null; return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height), midY: Math.round(b.y + b.height/2) } }
      const nav = document.querySelector('.nav-item')
      const menus = Array.from(document.querySelectorAll('.menu-item-btn'))
      return {
        logo: bx(document.querySelector('.sidebar-header .logo-icon')),
        toggle: bx(document.querySelector('.menu-toggle-btn')),
        navIcon: bx(nav?.querySelector('svg')),
        // A hidden label has display:none, so read visibility rather than
        // geometry — getBoundingClientRect would still report the old box.
        menus: menus.filter(m => getComputedStyle(m).display !== 'none')
                     .map(m => ({ t: m.textContent.trim(), x: bx(m)?.x, w: bx(m)?.w, midY: bx(m)?.midY })),
        collapsedAttr: document.querySelector('.traffic-sidebar-zone')?.getAttribute('data-collapsed'),
        barH: Math.round(document.querySelector('.traffic-spacer')?.getBoundingClientRect().height || 0),
      }
    })

    const label = `${plat}/${collapsed ? 'collapsed' : 'expanded'}`
    const logoVsNav = (r.logo && r.navIcon) ? (r.logo.x === r.navIcon.x ? 'ALIGNED' : `diff ${r.logo.x - r.navIcon.x}`) : 'n/a'
    const vAlign = r.toggle && r.menus[0] ? (r.toggle.midY === r.menus[0].midY ? 'same' : `diff ${r.toggle.midY - r.menus[0].midY}`) : 'n/a'
    const gaps = r.menus.length > 1 ? (r.menus[1].x - (r.menus[0].x + r.menus[0].w)) : 'n/a'
    const expectMenus = collapsed ? 0 : 3
    const ok = r.menus.length === expectMenus
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(20)} collapsed=${r.collapsedAttr} logo=${r.logo ? r.logo.x + '/' + r.logo.w + 'px' : 'hidden'} logoVsNav=${logoVsNav} bar=${r.barH}px vMid=${vAlign} menuGap=${gaps} menus=${r.menus.length} [${r.menus.map(m=>m.t).join(',')}]`)
    await p.close()
  }
}
await b.close()
