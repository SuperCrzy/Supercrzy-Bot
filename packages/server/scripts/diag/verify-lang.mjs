import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] })
for (const lang of ['zh', 'en']) {
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
  await p.addInitScript((l) => {
    localStorage.setItem('supercrzy-lang', l === 'zh' ? 'zh-CN' : 'en-US')
    window.supercrzyDesktop = { isDesktop: true, platform: 'win32', onBackendStatus: (cb) => cb({ status: 'ready' }), app: { getInfo: async () => ({ version: '1.3.3', packaged: true }) } }
  }, lang)
  await p.goto('http://127.0.0.1:5173/?preview=1', { waitUntil: 'domcontentloaded', timeout: 45000 })
  await p.waitForTimeout(5000)
  const r = await p.evaluate(() => ({
    menus: Array.from(document.querySelectorAll('.menu-item-btn')).map(e => e.textContent.trim()),
    widths: Array.from(document.querySelectorAll('.menu-item-btn')).map(e => Math.round(e.getBoundingClientRect().width)),
    title: (document.querySelector('.traffic-session-title')?.textContent || '').trim(),
    barH: Math.round(document.querySelector('.traffic-spacer')?.getBoundingClientRect().height || 0),
  }))
  console.log(lang.toUpperCase() + ':', JSON.stringify(r))
  // Open the File menu and read its rows
  await p.click('.menu-item-btn').catch(() => {})
  await p.waitForTimeout(500)
  const rows = await p.evaluate(() => ({
    labels: Array.from(document.querySelectorAll('.app-menu-label')).map(e => e.textContent.trim()),
    shortcuts: Array.from(document.querySelectorAll('.app-menu-shortcut')).map(e => e.textContent.trim()),
  }))
  console.log(lang.toUpperCase() + ' menu rows:', JSON.stringify(rows))
  await p.close()
}
await b.close()
