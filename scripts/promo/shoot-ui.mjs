// 项目根由脚本位置推导 —— 不许写死本机绝对路径（对外发布后会指向不存在的目录，
// 且会把开发机的用户名带进公开仓库）。
import { fileURLToPath as __f2p } from 'node:url'
import { dirname as __dn, join as __j } from 'node:path'
const __ROOT = __j(__dn(__f2p(import.meta.url)), '../..')
const { chromium } = await import(__ROOT + '/packages/server/node_modules/playwright-core/index.mjs')
import { mkdirSync } from 'node:fs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = 'http://localhost:3000'
const OUT = '/tmp/scpv-build/ui'

const routes = [
  ['01-chat', '/'],
  ['02-gateway', '/gateway'],
  ['03-memory', '/memory'],
  ['04-skills', '/skills'],
  ['05-automations', '/automations'],
  ['06-models', '/models'],
  ['07-usage', '/usage'],
  ['08-routines', '/routines'],
  ['09-collab', '/collab'],
  ['10-news', '/news'],
]

const themes = process.argv[2] ? [process.argv[2]] : ['light', 'dark']

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--force-device-scale-factor=2', '--hide-scrollbars', '--disable-lcd-text'],
})

for (const theme of themes) {
  const dir = `${OUT}/${theme}`
  mkdirSync(dir, { recursive: true })
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
  })
  await ctx.addInitScript((t) => {
    try { localStorage.setItem('supercrzy:theme', t) } catch { /* noop */ }
  }, theme)
  const page = await ctx.newPage()
  for (const [name, path] of routes) {
    const t0 = Date.now()
    try {
      await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
      await page.waitForTimeout(2200)
      await page.screenshot({ path: `${dir}/${name}.png` })
      console.log(`ok   ${theme}/${name}  ${Date.now() - t0}ms`)
    } catch (e) {
      console.log(`FAIL ${theme}/${name}  ${e.message}`)
    }
  }
  await ctx.close()
}
await browser.close()
console.log('done')
