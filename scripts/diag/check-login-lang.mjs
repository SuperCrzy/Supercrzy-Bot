/**
 * Geometry check: the login screen's language switch vs the Windows
 * titleBarOverlay controls (top-right ~140×56 band). Boss report 2026-10-29:
 * on Windows the 中文/English switch sat under the minimise/maximise/close
 * buttons; macOS was fine.
 *
 * Run: node scripts/diag/check-login-lang.mjs [url]
 * Exit 0 = both platform variants pass.
 */
import { chromium } from 'playwright-core'

const URL = process.argv.slice(2).find((a) => a.startsWith('http')) || 'http://localhost:5170/'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const browser = await chromium.launch({ executablePath: CHROME })
const results = []

function check(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

for (const platform of ['win32', 'darwin']) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript((p) => {
    window.supercrzyDesktop = {
      isDesktop: true,
      onBackendStatus: () => {},
      app: { getInfo: async () => ({ platform: p, version: '0.0.0-probe' }) },
    }
  }, platform)
  await page.goto(`${URL}login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.login-lang', { timeout: 30000 })
  await page.waitForTimeout(300) // platform resolves async on the first tick after mount

  const lang = await page.locator('.login-lang').boundingBox()
  const vw = await page.evaluate(() => window.innerWidth)

  if (platform === 'win32') {
    // The overlay band the OS paints over the web content.
    const band = { x: vw - 140, y: 0, w: 140, h: 56 }
    const overlaps =
      !!lang && lang.x < band.x + band.w && lang.x + lang.width > band.x &&
      lang.y < band.y + band.h && lang.y + lang.height > band.y
    check('win: 切换器不在系统按钮区（140×56 右上）内', !overlaps,
      `lang.x2=${Math.round(lang.x + lang.width)} band.x=${band.x}`)
    check('win: 切换器右缘 ≈ 160px 让位', Math.abs(vw - (lang.x + lang.width) - 160) <= 2,
      `right gap=${Math.round(vw - lang.x - lang.width)}`)
  } else {
    check('mac: 切换器保持右上 22px（红绿灯在左上，不冲突）',
      Math.abs(vw - (lang.x + lang.width) - 22) <= 2,
      `right gap=${Math.round(vw - lang.x - lang.width)}`)
  }
  await page.screenshot({ path: `/tmp/login-lang-${platform}.png` })
  await page.close()
}

await browser.close()
const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
