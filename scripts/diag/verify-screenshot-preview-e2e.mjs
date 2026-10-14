/**
 * 真机端到端：AI 截屏路径 → 右栏预览必须是**图片**，不是乱码（P1 #2 验收，2026-09-29）。
 *
 * 走的是真实链路：client dev(:5173) → vite proxy → server(:3000) →
 * `/api/filesystem/read` 拿 kind:media → `<img src="/api/filesystem/raw?...">`。
 *
 * 为什么不能只靠单测：单测只钉住 `openFilePreview` 的分流；「点正文里的路径链接」
 * 这一段是 `MessageFlowRenderer` 的事件委托 → `openFilePreview`，属于集成面，
 * 单测覆盖不到（老板方法论：单测全绿 ≠ 集成正确）。
 *
 * 用法：node scripts/diag/verify-screenshot-preview-e2e.mjs [needle]
 */
import { createRequire } from 'node:module'
// 项目根由脚本位置推导 —— 不许写死本机绝对路径（对外发布后会指向不存在的目录，
// 且会把开发机的用户名带进公开仓库）。
import { fileURLToPath as __f2p } from 'node:url'
import { dirname as __dn, join as __j } from 'node:path'
const __ROOT = __j(__dn(__f2p(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const { chromium } = require(__ROOT + '/packages/server/node_modules/playwright-core')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = 'http://localhost:5173'
const NEEDLE = process.argv[2] || '1790664894970'
const SESSION_TITLE_HINT = 'AI Agent 在 2026'

const log = (...a) => console.log(...a)
let failures = 0
function check(name, ok, extra = '') {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
  if (!ok) failures += 1
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
const netErrors = []
page.on('console', (m) => { if (m.type() === 'error') netErrors.push(m.text().slice(0, 160)) })

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  // 侧边栏会话列表：先 dump，再按标题模糊点开
  const items = await page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .filter((el) => el.children.length === 0 && (el.textContent || '').includes('AI Agent 在 2026'))
      .map((el) => ({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 60), text: (el.textContent || '').slice(0, 40) })),
  )
  log('侧边栏命中候选:', JSON.stringify(items))
  check('侧边栏存在目标会话条目', items.length > 0, JSON.stringify(items.slice(0, 2)))

  if (items.length > 0) {
    await page.evaluate((hint) => {
      const el = [...document.querySelectorAll('*')]
        .filter((e) => e.children.length === 0 && (e.textContent || '').includes(hint))
      const clickable = el[0]?.closest('[class*=session],[class*=item],li,button,a') || el[0]
      clickable?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, SESSION_TITLE_HINT)
  }
  await page.waitForTimeout(3000)

  // 找到正文里那条截图路径
  const linkInfo = await page.evaluate((needle) => {
    const links = [...document.querySelectorAll('.msg-path-link')]
    const hit = links.find((l) => (l.textContent || '').includes(needle))
    return { total: links.length, found: !!hit, text: hit ? hit.textContent : '', dataPath: hit ? hit.dataset.path : '' }
  }, NEEDLE)
  log('正文路径链接:', JSON.stringify(linkInfo))
  check('正文里存在可点的截图路径链接', linkInfo.found, linkInfo.text)

  if (linkInfo.found) {
    await page.evaluate((needle) => {
      const hit = [...document.querySelectorAll('.msg-path-link')].find((l) => (l.textContent || '').includes(needle))
      hit?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, NEEDLE)
    // openFilePreview 是异步 fetch + 800ms 防抖（DetailPanel 的 previewTs watcher）
    await page.waitForTimeout(3500)

    const res = await page.evaluate(async () => {
      const raw = await fetch('/api/filesystem/read?path=' + encodeURIComponent(document.querySelector('.msg-path-link')?.dataset.path || ''))
      const d = await raw.json().catch(() => ({}))
      const img = document.querySelector('.preview-image-obj')
      const pre = document.querySelector('.preview-code')
      return {
        kind: d.kind,
        imgSrc: img ? img.getAttribute('src') : null,
        imgLoaded: img ? img.naturalWidth : 0,
        preText: pre ? pre.textContent.slice(0, 60) : null,
      }
    })
    log('右栏状态:', JSON.stringify(res))

    check('后端对该路径返回 kind:media', res.kind === 'media', String(res.kind))
    check('右栏渲染出 <img> 且指向 /api/filesystem/raw', !!res.imgSrc && res.imgSrc.includes('/api/filesystem/raw'), String(res.imgSrc))
    check('图片真实解码成功（naturalWidth>0）', res.imgLoaded > 0, `naturalWidth=${res.imgLoaded}`)
    check('右栏不再是文本 <pre>（无 IFDR 乱码）', !(res.preText || '').includes('IHDR'), String(res.preText))
  }

  log('浏览器端 console.error 条数:', netErrors.length)
  if (netErrors.length) log(netErrors.join('\n'))
} finally {
  await browser.close()
}

log(failures === 0 ? '\n结果：全部通过' : `\n结果：${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
