/**
 * Renders the right panel with a mocked session + artifact list and checks:
 *   1. the artifact group appears with both rows,
 *   2. right-click opens the menu with three actions.
 *
 * The API requires a login, so requests are intercepted. The panel starts
 * collapsed by CSS class, which leaves rows with no box — it is expanded here
 * because this checks the group, not the collapse animation.
 */
import { chromium } from 'playwright-core'

const SID = 'mock-session-1'
const ARTIFACTS = [
  { id: 'a1', session_id: SID, name: 'demo.txt', path: '/tmp/artcheck/demo.txt', mime: 'text/plain', size: 20, action: 'created', created_at: '2026-11-21T00:00:00Z' },
  { id: 'a2', session_id: SID, name: 'report.md', path: '/tmp/artcheck/report.md', mime: 'text/markdown', size: 2048, action: 'created', created_at: '2026-11-21T00:00:00Z' },
]

const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
})
const p = await b.newPage({ viewport: { width: 1500, height: 900 } })

await p.route('**/api/**', (route) => {
  const path = new URL(route.request().url()).pathname
  const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  if (path === '/api/sessions') return json([{ id: SID, title: 'Mock session', archived: 0, created_at: '2026-11-21T00:00:00Z', updated_at: '2026-11-21T00:00:00Z' }])
  if (path === `/api/sessions/${SID}/artifacts`) return json(ARTIFACTS)
  if (path === `/api/sessions/${SID}`) return json({ id: SID, title: 'Mock session', messages: [] })
  return json({})
})

await p.addInitScript(() => {
  window.supercrzyDesktop = { isDesktop: true, platform: 'win32', onBackendStatus: (cb) => cb({ status: 'ready' }), app: { getInfo: async () => ({ version: '1.3.4', packaged: true }) } }
})
await p.goto('http://localhost:5174/?preview=1', { waitUntil: 'domcontentloaded', timeout: 45000 })
await p.waitForTimeout(6000)

await p.evaluate(() => {
  const el = Array.from(document.querySelectorAll('*')).find(x => x.textContent?.trim() === 'Mock session')
  if (el) el.click()
})
await p.waitForTimeout(2200)

await p.evaluate(() => {
  const tab = Array.from(document.querySelectorAll('.panel-tab')).find(el => /文件|Files/.test(el.textContent || ''))
  if (tab) tab.click()
})
await p.waitForTimeout(1500)

// The panel starts collapsed; give it a box so rows are clickable.
await p.evaluate(() => document.querySelector('.detail-panel')?.classList.add('visible'))
await p.waitForTimeout(700)

const state = await p.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('.artifact-group .file-row.is-artifact'))
  return {
    groupRendered: !!document.querySelector('.artifact-group'),
    groupTitle: document.querySelector('.artifact-group .group-title')?.textContent?.trim() || null,
    rowCount: rows.length,
    names: rows.map(r => r.querySelector('.file-name')?.textContent?.trim()),
    sizeLabels: rows.map(r => r.querySelector('.file-size')?.textContent?.trim()),
    rowTitles: rows.map(r => r.getAttribute('title')),
  }
})
console.log('GROUP:', JSON.stringify(state, null, 1))

if (state.rowCount > 0) {
  await p.locator('.artifact-group .file-row.is-artifact').first().click({ button: 'right' })
  await p.waitForTimeout(600)
  const menu = await p.evaluate(() => {
    const m = document.querySelector('.artifact-menu')
    const box = m?.getBoundingClientRect()
    return {
      open: !!m,
      items: Array.from(m?.querySelectorAll('.artifact-menu-item') || []).map(x => x.textContent?.trim()),
      position: box ? { x: Math.round(box.x), y: Math.round(box.y) } : null,
    }
  })
  console.log('MENU:', JSON.stringify(menu, null, 1))
}

const ok = state.groupRendered && state.rowCount === 2 && state.names.join(',') === 'demo.txt,report.md'
console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL')
await b.close()
