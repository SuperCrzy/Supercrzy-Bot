// 项目根由脚本位置推导 —— 不许写死本机绝对路径（对外发布后会指向不存在的目录，
// 且会把开发机的用户名带进公开仓库）。
import { fileURLToPath as __f2p } from 'node:url'
import { dirname as __dn, join as __j } from 'node:path'
const __ROOT = __j(__dn(__f2p(import.meta.url)), '../..')
const { chromium } = await import(__ROOT + '/packages/server/node_modules/playwright-core/index.mjs')
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const ROOT = '/tmp/scpv-build/web'
const OUT = '/tmp/scpv-build/out'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const MODE = process.argv[2] || 'preview'

const MIME = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.json': 'application/json',
}

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0])
    const p = join(ROOT, normalize(url === '/' ? '/index.html' : url))
    if (!p.startsWith(ROOT)) { res.writeHead(403).end('no'); return }
    const data = await readFile(p)
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(data)
  } catch { res.writeHead(404).end('not found') }
})
await new Promise((r) => server.listen(4173, '127.0.0.1', r))

await mkdir(OUT, { recursive: true })
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] })
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, acceptDownloads: true, locale: 'zh-CN' })
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log('[page:err]', m.text()) })
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load' })

const ready = await page.evaluate(() => window.__ready)
console.log('ready:', JSON.stringify(ready, null, 1))
// 兼容 v2(scenes) 与 v3(cards+vid) 两种 stage —— v3 不再用逐个 img 字段，
// 而是顺次探测 /vid/*.png，所以只需确认 vid 帧数 > 0。
if (Array.isArray(ready.scenes)) {
  const missing = ready.scenes.filter((s) => s.img && !ready.loaded.includes(s.img))
  if (missing.length) console.log('WARN 缺图:', JSON.stringify(missing))
} else if (!ready.vidFrames) {
  console.log('WARN 未加载到视频帧（/vid/*.png）—— 画面会是纯背景色')
}

if (MODE === 'preview') {
  const marks = [1.3, 2.9, 6.5, 11.2, 15.8, 20.2, 24.1, 27.6]
  for (const t of marks) {
    await page.evaluate((tt) => window.__drawAt(tt), t)
    await page.waitForTimeout(120)
    const el = await page.$('#c')
    await el.screenshot({ path: `${OUT}/preview_${String(t).replace('.', '_')}s.png` })
    console.log('preview', t + 's')
  }
} else if (MODE === 'measure') {
  const r = await page.evaluate(async () => {
    const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src })
    const stat = (im, sx, sy, sw, sh) => {
      const c = document.createElement('canvas'); c.width = sw; c.height = sh
      const x = c.getContext('2d'); x.drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh)
      const d = x.getImageData(0, 0, sw, sh).data
      let R = 0, n = 0
      for (let i = 0; i < d.length; i += 4) { R += d[i]; n++ }
      return Math.round(R / n)
    }
    const out = { grid: [] }
    const src = await load('/vid/v0000.png')
    if (!src) return { err: 'vid 未加载' }
    window.__drawAt(6.5)
    const cnv = document.getElementById('c')
    const blocks = [[0.1, 0.15], [0.5, 0.15], [0.85, 0.15], [0.1, 0.5], [0.5, 0.5], [0.85, 0.5], [0.1, 0.85], [0.5, 0.85], [0.85, 0.85]]
    for (const [fx, fy] of blocks) {
      const w = Math.round(src.width * 0.12), h = Math.round(src.height * 0.12)
      const sx = Math.round(src.width * fx) - w / 2, sy = Math.round(src.height * fy) - h / 2
      const sw2 = Math.round(w / 2), sh2 = Math.round(h / 2)
      const cx = Math.round(cnv.width * fx) - sw2 / 2, cy = Math.round(cnv.height * fy) - sh2 / 2
      out.grid.push({
        at: `${fx}/${fy}`,
        src: stat(src, sx, sy, w, h),
        frame: stat(cnv, cx, cy, sw2, sh2),
      })
    }
    return out
  })
  console.log('measure:', JSON.stringify(r))
} else {
  await page.exposeFunction('__onProgress', (i, n) => {
    if (i % 150 === 0) console.log(`  编码 ${i}/${n}`)
  })
  const t0 = Date.now()
  const dlPromise = page.waitForEvent('download', { timeout: 1800000 })
  const r = await page.evaluate(async () => {
    return await window.__encodeAndDownload((i, n) => window.__onProgress(i, n))
  })
  console.log('encoded:', JSON.stringify(r), `用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  const dl = await dlPromise
  const target = join(OUT, 'SUPERCRZY_BOT_PROMO_30s_1080p.mp4')
  await dl.saveAs(target)
  console.log('saved ->', target)
}

await browser.close()
server.close()
process.exit(0)
