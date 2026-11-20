import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []
p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)) })
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message.slice(0, 200)))
await p.addInitScript(() => {
  window.supercrzyDesktop = { isDesktop: true, platform: 'win32', onBackendStatus: (cb) => cb({ status: 'ready' }), app: { getInfo: async () => ({ version: '1.3.3', packaged: true }) } }
})
await p.goto('http://127.0.0.1:5173/?preview=1', { waitUntil: 'domcontentloaded', timeout: 45000 })
await p.waitForTimeout(6000)
console.log('URL:', p.url())
console.log('has app-layout:', await p.evaluate(() => !!document.querySelector('.app-layout')))
console.log('has traffic-spacer:', await p.evaluate(() => !!document.querySelector('.traffic-spacer')))
console.log('body head:', (await p.evaluate(() => document.body.innerText.slice(0, 200))).replace(/\n+/g, ' | '))
console.log('ERRORS:', errs.slice(0, 5).join('  ///  '))
await p.screenshot({ path: '/tmp/probe2.png', fullPage: false })
await b.close()
