/**
 * End to end: does navigating to a real phone site actually end up at 390px?
 * Goes through the real navigate() so the re-render path is exercised, not just
 * the scoring function.
 */
import { initDatabase } from '../../src/services/database.js'
import * as browser from '../../src/services/ai-browser.js'

initDatabase()
// Chrome must not inherit the sandbox proxy.
for (const k of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy']) delete process.env[k]

const CASES = [
  { url: 'https://m.baidu.com', expect: 'mobile' },
  { url: 'https://www.baidu.com', expect: 'desktop' },
]

for (const c of CASES) {
  const t0 = Date.now()
  try {
    const snap = await (browser as any).browserNavigate(c.url)
    const ms = Date.now() - t0
    const w = snap.viewport?.width
    const kind = snap.layout?.kind
    const ok = kind === c.expect && (c.expect === 'mobile' ? w === 390 : w === 1280)
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.url.padEnd(26)} kind=${String(kind).padEnd(8)} viewport=${w}x${snap.viewport?.height} ${ms}ms`)
    console.log(`       reasons=${JSON.stringify(snap.layout?.reasons)} title=${(snap.title || '').slice(0, 20)}`)
  } catch (e: any) {
    console.log(`ERROR ${c.url}: ${String(e?.message || e).split('\n')[0].slice(0, 90)}`)
  }
}
await (browser as any).closeAllBrowsers?.()
process.exit(0)
