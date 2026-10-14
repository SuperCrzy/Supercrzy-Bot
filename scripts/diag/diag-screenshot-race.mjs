/**
 * 对照实验：点截图路径链接的**时机**会不会影响右栏出图（2026-09-29）。
 *
 * 起因：验收脚本 verify-screenshot-preview-e2e.mjs 有一次跑出
 *   {imgSrc:null, imgLoaded:0, preText:null} —— 右栏既没图也不是文本。
 * 两种解释必须分开：
 *   (a) 脚本抢跑：固定 waitForTimeout 不够，属于**测量工具**的 bug；
 *   (b) 产品竞态：会话还在加载/重渲染时点链接，右栏状态被后续状态更新顶掉 —— **真 bug**。
 *
 * 做法：同一个页面，用不同「打开会话 → 点击」的延迟各跑一遍，看何时开始失败。
 *
 * 用法：node scripts/diag/diag-screenshot-race.mjs
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('/Users/chaojiphonekuang/Downloads/supercrzy/supercrzy-agent/packages/server/node_modules/playwright-core')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = 'http://localhost:5173'
const NEEDLE = process.argv[2] || '1790664894970'
const SETTLE_DELAYS = (process.argv[3] || '500,1200,2500,4000').split(',').map(Number)

const browser = await chromium.launch({ executablePath: CHROME, headless: true })

for (const settle of SETTLE_DELAYS) {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } })
  const errs = []
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)) })
  let result
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
    await page.evaluate((hint) => {
      const title = [...document.querySelectorAll('.chat-item-title')].find((e) => (e.textContent || '').includes(hint))
      const clickable = title?.closest('[class*=chat-item],li,button,a') || title
      clickable?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, 'AI Agent 在 2026')

    // ← 关键变量：会话打开后等多久才点链接
    await page.waitForTimeout(settle)

    const clickedAt = await page.evaluate((needle) => {
      const hit = [...document.querySelectorAll('.msg-path-link')].find((l) => (l.dataset.path || '').includes(needle))
      if (!hit) return 'link-not-found'
      hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      return 'clicked'
    }, NEEDLE)

    // 点完给足时间（这里的等待只在"点已经发生"之后，不计入 settle）
    await page.waitForTimeout(3000)

    result = await page.evaluate(() => {
      const img = document.querySelector('.preview-image-obj')
      const panel = document.querySelector('[class*="detail-panel"]')
      return {
        imgFound: !!img,
        natW: img ? img.naturalWidth : 0,
        src: img ? (img.getAttribute('src') || '').slice(0, 60) : null,
        tabEmpty: !!document.querySelector('.tab-empty'),
        panelMounted: !!panel,
        activeTab: (document.querySelector('[class*="tab"][class*="active"]')?.textContent || '').trim().slice(0, 8),
      }
    })
    result.clickedAt = clickedAt
  } catch (e) {
    result = { error: String(e).slice(0, 200) }
  } finally {
    await page.close()
  }
  const ok = result.imgFound && result.natW > 0
  console.log(`settle=${String(settle).padStart(5)}ms  ${ok ? 'OK  ' : 'FAIL'}  ${JSON.stringify(result)}${errs.length ? '  consoleErr=' + errs.length : ''}`)
}

await browser.close()
