/**
 * Starts sign-in and holds the page open, polling a code file.
 *
 * Everything has to happen in one page session: reopening the authorization URL
 * drops back to step 1, and re-submitting the email invalidates the code already
 * in the user's inbox. So this opens the page once, submits the email once, then
 * waits for the code to appear in /tmp/login-code.txt and types it in that same
 * page.
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'

const EMAIL = '805205780@qq.com'
const CODE_FILE = '/tmp/login-code.txt'
const LOGIN_URL = fs.readFileSync('/tmp/login-url.txt', 'utf8').trim()

try { fs.unlinkSync(CODE_FILE) } catch { /* no stale code */ }

const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--no-proxy-server'],
})
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } })
const p = await ctx.newPage()

await p.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await p.waitForTimeout(2500)
await p.waitForSelector('#email', { timeout: 20000 })
await p.fill('#email', EMAIL)
await p.locator('button', { hasText: 'Continue with email' }).first().click()
await p.waitForTimeout(2500)
console.log('CODE_SENT — waiting for code in', CODE_FILE)

// Poll for the code, up to 8 minutes.
let code = ''
for (let i = 0; i < 480; i++) {
  if (fs.existsSync(CODE_FILE)) {
    code = (fs.readFileSync(CODE_FILE, 'utf8') || '').trim()
    if (/^\d{6}$/.test(code)) break
  }
  await p.waitForTimeout(1000)
}
if (!/^\d{6}$/.test(code)) {
  console.log('NO_CODE — gave up waiting')
  await b.close(); process.exit(2)
}
console.log('got code, typing it')

const first = p.locator('input[maxlength="1"]').first()
await first.click({ timeout: 15000 })
for (const d of code) {
  await p.keyboard.type(d, { delay: 130 })
  await p.waitForTimeout(200)
}
await p.waitForTimeout(2500)

const verify = p.locator('button', { hasText: /Verify and continue/i }).first()
if (await verify.count() > 0 && await verify.isVisible()) {
  await verify.click().catch(() => {})
  await p.waitForTimeout(5000)
}

const final = await p.evaluate(() => ({ url: location.href, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 260) }))
console.log('FINAL_URL:', final.url)
console.log('FINAL_TEXT:', final.text)
await b.close()
