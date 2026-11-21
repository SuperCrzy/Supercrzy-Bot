/**
 * Walks every route and every settings tab, recording console errors, failed
 * requests, and whether the page rendered anything. The point is to find the
 * pages that are silently broken, not to assert pixel layouts.
 */
import { chromium } from 'playwright-core'

const ROUTES = [
  ['/', 'Home'], ['/chat', 'Chat'], ['/explore', 'Explore'], ['/news', 'News'],
  ['/memory', 'Memory'], ['/skills', 'Skills'], ['/automation', 'AutomationHub'],
  ['/automations', 'Automations'], ['/routines', 'Routines'], ['/collab', 'CollabWorkbench'],
  ['/search', 'Search'], ['/rank', 'Rank'], ['/usage', 'Usage'], ['/logs', 'Logs'],
  ['/settings', 'Settings'], ['/models', 'Models'], ['/images', 'ImagesSettings'],
  ['/gateway', 'Gateway'], ['/lab', 'Lab'], ['/account', 'Account'], ['/about', 'About'],
]

const b = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--no-proxy-server'],
})
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } })
await ctx.addInitScript(() => {
  window.supercrzyDesktop = {
    isDesktop: true, platform: 'darwin',
    onBackendStatus: (cb) => cb({ status: 'ready' }),
    app: { getInfo: async () => ({ version: '1.3.4', packaged: false }) },
  }
})

const results = []
for (const [path, name] of ROUTES) {
  const p = await ctx.newPage()
  const errs = []
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 90)) })
  p.on('pageerror', e => errs.push('PAGEERROR ' + String(e.message).slice(0, 90)))
  p.on('requestfailed', r => {
    const u = r.url()
    if (u.includes('/api/')) errs.push('REQFAIL ' + u.replace(/^https?:\/\/[^/]+/, '').slice(0, 60))
  })
  let statusCode = 0
  p.on('response', r => { if (r.url().includes('/api/')) statusCode = Math.max(statusCode, r.status() >= 400 ? r.status() : 0) })

  try {
    await p.goto(`http://localhost:5173${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await p.waitForTimeout(2500)
    const txt = (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').trim()
    const redirected = /login/i.test(p.url())
    results.push({
      name, path, redirected,
      len: txt.length,
      head: txt.slice(0, 60),
      err: [...new Set(errs)].slice(0, 3),
      http: statusCode,
    })
  } catch (e) {
    results.push({ name, path, error: String(e.message).split('\n')[0].slice(0, 60) })
  }
  await p.close()
}

for (const r of results) {
  if (r.error) { console.log(`ERR  ${r.name.padEnd(16)} ${r.error}`); continue }
  const flag = r.len < 80 ? 'EMPTY' : (r.err.length ? 'WARN ' : 'OK   ')
  console.log(`${flag} ${r.name.padEnd(16)} ${String(r.len).padStart(5)}ch  ${r.redirected ? '[->login] ' : ''}${r.head.slice(0, 42)}`)
  if (r.err.length) console.log(`       ${r.err.join(' | ')}`)
}
await b.close()
