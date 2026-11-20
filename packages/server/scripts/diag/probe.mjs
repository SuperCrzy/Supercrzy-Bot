import { chromium } from 'playwright-core'
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1400, height: 900 } })
await p.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded', timeout: 30000 })
await p.waitForTimeout(3000)
console.log('URL:', p.url())
console.log('BODY:', (await p.evaluate(() => document.body.innerText.slice(0, 300))).replace(/\n+/g, ' | '))
await p.screenshot({ path: '/tmp/page-state.png' })
await b.close()
