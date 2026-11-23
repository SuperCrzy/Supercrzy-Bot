/**
 * Finish the sign-in with a six-digit code.
 *
 * The form renders six single-character boxes and submits on the last digit, so
 * the boxes must be filled in order with a small gap between keystrokes; filling
 * them too fast leaves the last one empty and nothing submits.
 *
 * Never re-submits the email: doing that mints a new code and invalidates the
 * one the user just read (this cost one round trip already).
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'

const CODE = (process.argv[2] || '').trim()
const LOGIN_URL = fs.readFileSync('/tmp/login-url.txt', 'utf8').trim()
if (!/^\d{6}$/.test(CODE)) { console.log('need a 6-digit code'); process.exit(1) }

const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--no-proxy-server'],
})
const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } })
const p = await ctx.newPage()

await p.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await p.waitForTimeout(2500)
console.log('opened:', p.url().slice(0, 60))

// If the portal shows step 1, submit the email once.
const boxesNow = await p.$$('input[maxlength="1"]')
if (boxesNow.length < 6) {
  const email = await p.$('#email')
  if (email && (await email.isVisible())) {
    await p.fill('#email', '805205780@qq.com')
    await p.locator('button', { hasText: 'Continue with email' }).first().click()
    await p.waitForTimeout(2500)
    console.log('email submitted (was on step 1)')
  }
}

// Focus the first box, then type the digits like a person would.
const first = p.locator('input[maxlength="1"]').first()
await first.click({ timeout: 15000 })
await p.waitForTimeout(300)
for (const d of CODE) {
  await p.keyboard.type(d, { delay: 120 })
  await p.waitForTimeout(180)
}
await p.waitForTimeout(2000)

const mid = await p.evaluate(() => ({
  codes: Array.from(document.querySelectorAll('input[maxlength="1"]')).map(i => i.value).join(''),
  text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
}))
console.log('typed so far:', mid.codes || '(none)')

// Submit if the form did not auto-advance.
const verify = p.locator('button', { hasText: /Verify and continue/i }).first()
if (await verify.count() > 0 && await verify.isVisible()) {
  await verify.click().catch(() => {})
  await p.waitForTimeout(4000)
}

const final = await p.evaluate(() => ({ url: location.href, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300) }))
console.log('FINAL URL:', final.url)
console.log('FINAL TEXT:', final.text)
await p.waitForTimeout(1500)
await b.close()
