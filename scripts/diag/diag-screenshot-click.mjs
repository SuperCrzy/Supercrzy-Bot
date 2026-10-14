/**
 * 诊断：点正文里的截图路径后，右栏为什么没出图（2026-09-29）。
 *
 * 与 verify-screenshot-preview-e2e.mjs 的区别：那个是**验收断言**，这个是**取证**。
 * 取证要点：
 *  1. 装 fetch 探针（记录点链接后真实发出的 /api 请求 + 状态码 + 响应体前 200 字）；
 *  2. 记录 console 的**全部**输出（openFilePreview 失败时会 console.error('[openFilePreview]', …)）；
 *  3. dump 右栏真实 DOM 结构（activeTab、有没有 .preview-image-obj / .preview-code / .tab-empty）。
 *
 * 用法：node scripts/diag/diag-screenshot-click.mjs [needle]
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('/Users/chaojiphonekuang/Downloads/supercrzy/supercrzy-agent/packages/server/node_modules/playwright-core')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = 'http://localhost:5173'
const NEEDLE = process.argv[2] || '1790664894970'

const log = (...a) => console.log(...a)

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })

const consoleLines = []
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`))
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 300)}`))
page.on('requestfailed', (r) => consoleLines.push(`[requestfailed] ${r.url().slice(0, 140)} :: ${r.failure()?.errorText}`))

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  // ---- 装 fetch 探针（必须在点击之前）----
  await page.evaluate(() => {
    window.__fetchLog = []
    const orig = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input?.url || '')
      const rec = { url: url.slice(0, 200), method: (init?.method || 'GET'), status: null, bodyHead: null, err: null }
      window.__fetchLog.push(rec)
      try {
        const res = await orig(input, init)
        rec.status = res.status
        rec.ctype = res.headers.get('content-type') || ''
        // 只对小型 JSON 响应取体（避免把 PNG 读进内存）
        if ((rec.ctype.includes('json') || rec.ctype.includes('text')) && url.includes('/api/')) {
          try {
            const clone = res.clone()
            const txt = await clone.text()
            rec.bodyHead = txt.slice(0, 200)
          } catch { /* ignore */ }
        }
        return res
      } catch (e) {
        rec.err = String(e).slice(0, 160)
        throw e
      }
    }
  })

  // ---- 打开会话 ----
  const clicked = await page.evaluate((hint) => {
    const el = [...document.querySelectorAll('*')].filter((e) => e.children.length === 0 && (e.textContent || '').includes(hint))
    const title = [...document.querySelectorAll('.chat-item-title')].find((e) => (e.textContent || '').includes(hint))
    const target = title || el[0]
    const clickable = target?.closest('[class*=chat-item],li,button,a') || target
    clickable?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return { found: !!target, cls: clickable ? clickable.className : null }
  }, 'AI Agent 在 2026')
  log('打开会话:', JSON.stringify(clicked))
  await page.waitForTimeout(3500)

  // ---- 找目标链接 ----
  const links = await page.evaluate((needle) => {
    const all = [...document.querySelectorAll('.msg-path-link')]
    return {
      total: all.length,
      paths: all.slice(0, 20).map((l) => l.dataset.path || l.textContent || ''),
      hit: all.findIndex((l) => (l.dataset.path || l.textContent || '').includes(needle)),
    }
  }, NEEDLE)
  log('路径链接:', JSON.stringify(links, null, 1))

  // ---- 点击 ----
  await page.evaluate((needle) => {
    window.__fetchLog = []
    const hit = [...document.querySelectorAll('.msg-path-link')].find((l) => (l.dataset.path || '').includes(needle))
    hit?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }, NEEDLE)
  await page.waitForTimeout(4000)

  // ---- dump ----
  const state = await page.evaluate(() => {
    const panel = document.querySelector('.detail-panel') || document.querySelector('[class*="detail-panel"]')
    const dumpEl = (sel) => {
      const e = document.querySelector(sel)
      return e ? { cls: e.className, src: e.getAttribute?.('src') || null, natW: e.naturalWidth ?? null, text: (e.textContent || '').slice(0, 80) } : null
    }
    return {
      fetchLog: window.__fetchLog,
      panelFound: !!panel,
      panelCls: panel ? panel.className : null,
      panelHTMLlen: panel ? panel.innerHTML.length : 0,
      activeTabs: [...document.querySelectorAll('[class*="tab"][class*="active"],[class*="tab"].active')].map((e) => (e.textContent || '').trim().slice(0, 12)),
      allTabLabels: [...document.querySelectorAll('[class*="tab-item"],[class*="tab-btn"],.tab')].map((e) => (e.textContent || '').trim().slice(0, 12)).slice(0, 20),
      img: dumpEl('.preview-image-obj'),
      pre: dumpEl('.preview-code'),
      tabEmpty: !!document.querySelector('.tab-empty'),
      iframe: !!document.querySelector('iframe'),
      previewBoxAny: !!document.querySelector('[class*="preview"]'),
      previewClasses: [...document.querySelectorAll('[class*="preview"]')].map((e) => e.className).slice(0, 15),
    }
  })
  log('\n===== 点后状态 =====')
  log(JSON.stringify(state, null, 1))

  log('\n===== fetch 日志 =====')
  for (const f of state.fetchLog) log(`${f.status ?? 'ERR'} ${f.method} ${f.url}${f.err ? ' :: ' + f.err : ''}\n    -> ${f.ctype || ''} ${f.bodyHead || ''}`)

  log('\n===== console =====')
  for (const l of consoleLines.slice(-40)) log(l)
} finally {
  await browser.close()
}
