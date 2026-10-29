/**
 * Geometry check for the "maximise detail panel eats the title bar" fix (2026-10-28).
 *
 * What it proves, in a real browser against the real client bundle:
 *   1. maximised panel starts BELOW the 56px title strip (title strip stays visible)
 *   2. the header's right-panel toggle is still hit-testable while maximised
 *   3. three ways out work: header toggle, the panel's restore button, Escape
 *   4. switching tabs drops back to the normal 420px width
 *
 * Run: node scripts/diag/check-panel-maximize.mjs [url]
 */
import { chromium } from 'playwright-core'

const URL = process.argv.slice(2).find((a) => a.startsWith('http')) || 'http://localhost:5170/'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

// `--control` runs the same measurement with the fix disabled. The "panel starts below
// the strip" assertion must then FAIL (panel.y === 0) — otherwise the check is a
// tautology that would pass even with the bug present.
const CONTROL = process.argv.includes('--control')

// Reproduce the desktop shell: the 56px title strip (and Windows titleBarOverlay
// controls) only render when the preload bridge says we are inside Electron.
await page.addInitScript(() => {
  window.supercrzyDesktop = {
    isDesktop: true,
    onBackendStatus: () => {},
    app: { getInfo: async () => ({ platform: 'win32', version: '0.0.0-probe' }) },
  }
})

// Sign-in is server-gated; stub the single status probe so we land in the app shell.
await page.route('**/api/account/status', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ signedIn: true, email: 'probe@local', accountId: 'probe', expiresAt: null }),
  }),
)

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.app-layout', { timeout: 30000 })

// Open the detail panel from the header toggle (also proves the toggle is reachable).
await page.click('.traffic-actions .traffic-action-btn:last-child')
await page.waitForSelector('.detail-panel.visible', { timeout: 10000 })

// Switch to the AI browser tab (4th direct child: artifacts / files / preview / browser),
// then maximise. Direct-child selector on purpose: the "more" dropdown lives in a wrapper.
const browserTab = page.locator('.panel-tabs > .panel-tab').nth(3)
await browserTab.click()
await page.waitForTimeout(400)

if (CONTROL) {
  // Disable the containing block to re-create the pre-fix situation.
  await page.addStyleTag({ content: '.app-body { position: static !important }' })
  await page.waitForTimeout(200)
}

const normalBox = await page.locator('.detail-panel').boundingBox()
const maxBtn = page.locator('.browser-maxbtn')
if (!(await maxBtn.count())) {
  console.log('FATAL: maximise button not found — tab did not switch')
  await browser.close()
  process.exit(2)
}
await maxBtn.click()
await page.waitForTimeout(500)

const headerBox = await page.locator('.traffic-spacer').boundingBox()
const panelBox = await page.locator('.detail-panel').boundingBox()
const vw = await page.evaluate(() => window.innerWidth)

if (CONTROL) {
  const reproduced = !!panelBox && Math.round(panelBox.y) === 0
  console.log(
    `CONTROL: panel.y=${panelBox ? Math.round(panelBox.y) : 'n/a'} — ` +
      (reproduced ? 'bug reproduced (panel covers the title strip)' : 'NOT reproduced ⇒ the check may be a tautology'),
  )
  await page.screenshot({ path: '/tmp/panel-maximize-control.png' })
  await browser.close()
  process.exit(reproduced ? 0 : 1)
}

check(
  '标题横栏仍在视口顶部且高度 56',
  !!headerBox && Math.round(headerBox.y) === 0 && Math.round(headerBox.height) === 56,
  headerBox ? `y=${Math.round(headerBox.y)} h=${Math.round(headerBox.height)}` : 'missing',
)

check(
  '放大后面板从横栏下沿开始（未覆盖横栏）',
  !!panelBox && panelBox.y >= 56,
  `panel.y=${panelBox ? Math.round(panelBox.y) : 'n/a'}（要求 ≥56）`,
)

check(
  '放大后面板变宽（92% 级别）',
  !!panelBox && panelBox.width > (normalBox?.width ?? 0) * 1.5,
  `normal=${Math.round(normalBox?.width ?? 0)} → max=${Math.round(panelBox?.width ?? 0)}`,
)

// Right edge alignment: the Windows window controls sit at the top-right corner.
check(
  '放大后面板未越出视口右缘',
  !!panelBox && panelBox.x + panelBox.width <= vw + 1,
  `right=${Math.round((panelBox?.x ?? 0) + (panelBox?.width ?? 0))} / vw=${vw}`,
)
await page.screenshot({ path: '/tmp/panel-maximize-state.png' })

// Header toggle must be hit-testable: element at its centre must be the button itself.
const headerBtn = page.locator('.traffic-actions .traffic-action-btn:last-child')
const btnBox = await headerBtn.boundingBox()
const hitIsButton = await page.evaluate(({ x, y }) => {
  const el = document.elementFromPoint(x, y)
  return !!el?.closest('.traffic-actions .traffic-action-btn')
}, { x: btnBox.x + btnBox.width / 2, y: btnBox.y + btnBox.height / 2 })
check('横栏的右边栏按钮在放大态仍可点（未被面板盖住）', hitIsButton)

// Exit #1: the restore button in the panel's own tab strip.
const restoreBtn = page.locator('.panel-tabs .panel-close-btn').first()
check('面板 tab 行存在「还原」按钮', (await page.locator('.panel-tabs .panel-close-btn').count()) >= 2)
await restoreBtn.click()
await page.waitForTimeout(400)
let restored = await page.locator('.detail-panel').boundingBox()
check('点「还原」回到常规宽度', !!restored && Math.abs(restored.width - 420) < 4, `w=${Math.round(restored?.width ?? 0)}`)

// Exit #2: Escape.
await maxBtn.click()
await page.waitForTimeout(400)
check('再次放大成功', (await page.locator('.detail-panel').boundingBox())?.width > 700)
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
restored = await page.locator('.detail-panel').boundingBox()
check('Esc 退出放大', !!restored && Math.abs(restored.width - 420) < 4, `w=${Math.round(restored?.width ?? 0)}`)

// Exit #3: switching tabs collapses the maximised width.
await maxBtn.click()
await page.waitForTimeout(400)
await page.locator('.panel-tabs .panel-tab').first().click()
await page.waitForTimeout(400)
restored = await page.locator('.detail-panel').boundingBox()
check('切 tab 自动还原宽度', !!restored && Math.abs(restored.width - 420) < 4, `w=${Math.round(restored?.width ?? 0)}`)

// Exit #4: the header toggle closes the panel from a maximised state, and reopening
// must come back at the normal width (maximise state must not survive a close).
await browserTab.click()
await page.waitForTimeout(300)
await maxBtn.click()
await page.waitForTimeout(400)
check('重新放大成功（为关闭测试做准备）', ((await page.locator('.detail-panel').boundingBox())?.width ?? 0) > 700)
await page.click('.traffic-actions .traffic-action-btn:last-child')
await page.waitForTimeout(600)
const closed = await page.locator('.detail-panel.visible').count()
check('横栏按钮能关掉面板', closed === 0)
await page.click('.traffic-actions .traffic-action-btn:last-child')
await page.waitForTimeout(600)
const reopened = await page.locator('.detail-panel').boundingBox()
check(
  '重新打开是常规宽度（放大态不残留）',
  !!reopened && Math.abs(reopened.width - 420) < 4,
  `w=${Math.round(reopened?.width ?? 0)}`,
)

await page.screenshot({ path: '/tmp/panel-maximize-check.png' })
await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
