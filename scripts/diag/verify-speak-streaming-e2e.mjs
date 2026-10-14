/**
 * 端到端验收：流式朗读（方案 D）到底把「点击 → 真的出声」压到了多少。
 *
 * 关键区别（相对 16:5x 那版探针 verify-speak-dblclick）：
 *   音频**不再经过前端**。改造前 fetch('/api/tts') 返回整段 blob，探针靠 hook
 *   `HTMLMediaElement.play()` 且 `src.startsWith('blob:')` 就能抓到全部时间线；
 *   现在 fetch 只是 POST /api/tts/ticket 换一张票（~6ms），音频由
 *   `<audio src="/api/tts/stream?t=...">` 自己拉 —— 所以：
 *     · "点击 → 出声" 的终点必须靠 `playing` 事件（真的开始放）而不是 play() resolve
 *     · 上游/代理的**首字节**时刻只能从 Playwright 的 response 事件拿（页面内看不到）
 *
 * 四个 case（同一个页面时钟 performance.now()）：
 *   A 单击           —— 基准：点击→换票 / 换票→<audio> / <audio>→出声
 *   B 合成中再点一次 —— 静音死路回归：**必须出声**，且不得置"朗读已暂停"
 *   C B 之后再点一次 —— 不该出现"第三次才出声"的补点行为
 *   D 250ms 快速双击 —— 同上
 *
 * 只读：不删会话、不改设置、不写库。
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require('/Users/chaojiphonekuang/Downloads/supercrzy/supercrzy-agent/packages/server/node_modules/playwright-core')

const BASE = process.env.BASE || 'http://localhost:5173'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)))

/** 上游到浏览器的时序（页面内看不到的）：请求发出 → 响应头 → 首字节 */
const streams = []
page.on('request', (r) => {
  if (r.url().includes('/api/tts/stream')) {
    streams.push({ kind: 'request', t: Date.now(), token: (r.url().split('t=')[1] || '').slice(0, 8) })
  }
})
page.on('response', async (r) => {
  if (!r.url().includes('/api/tts/stream')) return
  const h = r.headers()
  streams.push({
    kind: 'response',
    t: Date.now(),
    status: r.status(),
    te: h['transfer-encoding'] || null,
    cl: h['content-length'] || null,
    accel: h['x-accel-buffering'] || null,
    type: h['content-type'] || null,
  })
})

await page.addInitScript(() => {
  window.__p = null
  window.__mk = (raw) => {
    window.__p = {
      clickAt: 0, clicks: [], tickets: [], play: [], playing: [], ended: [],
      rej: [], mediaErr: [], lite: 0, audios: [], samples: [], raw: !!raw,
    }
    window.__sampler && clearInterval(window.__sampler)
    window.__sampler = setInterval(() => {
      const p = window.__p
      if (!p) return
      const bar = document.querySelector('.speak-bar')
      const btn = Array.from(document.querySelectorAll('button[title*="朗读"]')).filter((b) => !b.closest('.speak-bar'))[0]
      p.samples.push({
        t: Math.round(performance.now() - p.clickAt),
        bar: bar ? String(bar.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24) : null,
        title: btn ? btn.title : null,
      })
    }, 300)
    return true
  }
  // 换票请求（POST /api/tts/ticket）
  const of = window.fetch
  window.fetch = async (u, init) => {
    const url = typeof u === 'string' ? u : String(u?.url || '')
    if (!url.includes('/api/tts')) return of(u, init)
    let len = 0
    try { len = String(JSON.parse(String(init?.body || '{}')).text || '').length } catch { }
    const t0 = performance.now()
    const rec = { t0, len, url, status: 0, t1: 0, err: '' }
    window.__p?.tickets.push(rec)
    try {
      const r = await of(u, init)
      rec.status = r.status
      await r.clone().text()          // 票是 JSON，且极小；不再有 blob
      rec.t1 = performance.now()
      return r
    } catch (e) {
      rec.err = String(e?.name || e?.message || e).slice(0, 120)
      rec.t1 = performance.now()
      throw e
    }
  }
  const OP = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function () {
    // 记下**每一次** play() 调用。改造前的静音死路症状就是"play 调用 = []"，
    // 所以这个计数本身是回归断言，不能只在 raw 模式下才记。
    const p = window.__p
    if (p) p.play.push({ t: performance.now(), src: String(this.src || '').slice(0, 46) })
    const pr = OP.call(this)
    pr.catch((e) => window.__p?.rej.push({ t: performance.now(), name: String(e?.name) }))
    return pr
  }
  const OA = window.Audio
  window.Audio = function (src) {
    const a = new OA(src)
    const p = window.__p
    p?.audios.push({ t: performance.now(), src: String(src || '').slice(0, 46) })
    a.addEventListener('playing', () => window.__p?.playing.push({ t: performance.now(), src: String(a.src || '').slice(0, 46) }))
    a.addEventListener('ended', () => window.__p?.ended.push({ t: performance.now() }))
    a.addEventListener('error', () => window.__p?.mediaErr.push({ t: performance.now(), code: a.error?.code }))
    return a
  }
  const ss = window.speechSynthesis
  if (ss) { const os = ss.speak.bind(ss); ss.speak = (u) => { if (window.__p) window.__p.lite++; return os(u) } }
})

/**
 * 找"目标消息自己的朗读按钮"。
 *
 * ⚠️ 这个函数踩过两次坑，都是**定位方式**而不是产品问题：
 *   ① 按 `button[title*="朗读"]` 的**裸索引**取 —— 标题会在"朗读/暂停朗读/继续朗读"之间变，
 *      朗读浮条的按钮标题同样含"朗读" ⇒ 索引漂移（第一版把"第二次点击"点空了）。
 *   ② 改成"消息容器内按正文最长锁定 + 记 `.message` 索引" —— 消息列表本身会增删
 *      （流式结束时动作行重建）⇒ 索引也会漂。
 * 最终用**正文文本做锚**：文本不变，容器和索引怎么重建都能找回来。
 */
const BTN_SEL = 'button[title*="朗读"],button[title*="暂停朗读"],button[title*="继续朗读"],button[title*="正在合成语音"]'

async function locateTarget() {
  return await page.evaluate((sel) => {
    const msgs = Array.from(document.querySelectorAll('.message'))
    let best = null
    for (const m of msgs) {
      if (!m.querySelector(sel)) continue
      const len = String(m.innerText || '').trim().length
      if (!best || len > best.len) best = { len, key: String(m.innerText || '').trim().slice(0, 60) }
    }
    return best
  }, BTN_SEL)
}

async function dismissModals() {
  await page.waitForTimeout(700)
  const has = async () => (await page.locator('.n-modal-mask').count()) > 0
  if (!(await has())) return
  await page.keyboard.press('Escape'); await page.waitForTimeout(300)
  if (await has()) { await page.mouse.click(12, 400); await page.waitForTimeout(300) }
}

async function clickSpeak(key) {
  return await page.evaluate(({ k, sel }) => {
    const msgs = Array.from(document.querySelectorAll('.message'))
    // 按正文锚找回目标消息：文本是稳定的，容器/索引怎么重建都能命中
    const target = msgs.find((m) => String(m.innerText || '').trim().includes(k)) || msgs.find((m) => m.querySelector(sel))
    const b = target?.querySelector(sel)
    if (!b) {
      // 点空时把当时的按钮标题打出来，否则"第二次点击"是没点中还是没生效分不清
      return {
        missing: true,
        msgCount: msgs.length,
        all: Array.from(document.querySelectorAll('button[title]')).map((x) => x.title).slice(-14),
      }
    }
    if (!window.__p.clickAt) window.__p.clickAt = performance.now()
    window.__p.clicks.push(performance.now())
    b.click()
    const bar = document.querySelector('.speak-bar')
    return { title: b.title, bar: bar ? bar.textContent.replace(/\s+/g, ' ').trim().slice(0, 24) : null }
  }, { k: key, sel: BTN_SEL })
}

async function readOut(tag, msgIdx) {
  return await page.evaluate(({ tg, mi }) => {
    const p = window.__p
    const c = p.clickAt
    const r = (x) => (x == null ? null : Math.round(x - c))
    const bar = document.querySelector('.speak-bar')
    const msgs = Array.from(document.querySelectorAll('.message'))
    const target = mi == null ? null
      : msgs.find((m) => String(m.innerText || '').trim().includes(mi))
    const btn = target?.querySelector('button[title*="朗读"],button[title*="暂停朗读"],button[title*="继续朗读"],button[title*="正在合成语音"]')
    return {
      case: tg,
      点击ms: p.clicks.map(r),
      换票: p.tickets.map((x) => ({ 发起ms: r(x.t0), 耗时ms: Math.round(x.t1 - x.t0), 状态: x.status, 字数: x.len, 错误: x.err })),
      audio创建ms: p.audios.map((x) => r(x.t)),
      play调用ms: p.play.map((x) => r(x.t)),
      真的出声ms: p.playing.map((x) => r(x.t)),
      play被拒: p.rej.map((x) => ({ ms: r(x.t), 名: x.name })),
      媒体错误: p.mediaErr.map((x) => ({ ms: r(x.t), code: x.code })),
      播完ms: p.ended.map(r),
      系统TTS次数: p.lite,
      最终朗读条: bar ? String(bar.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24) : null,
      最终按钮: btn ? btn.title : null,
      时间线: p.samples.filter((s, i) => i % 3 === 0).map((s) => `${s.t}:${s.title || '-'}`).slice(0, 22),
    }
  }, { tg: tag, mi: msgIdx })
}

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForTimeout(2500)
await dismissModals()

const bestTarget = await locateTarget()
if (!bestTarget) { console.log('本页没有「朗读」按钮 —— 无法测'); await browser.close(); process.exit(0) }
console.log(`目标：正文≈${bestTarget.len} 字，锚="${bestTarget.key.slice(0, 24)}…"\n`)

async function reset(raw) {
  await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll('.speak-bar-btn')).find((b) => /停止/.test(b.textContent || ''))
    if (s) s.click()
  })
  await page.waitForTimeout(1000)
  await page.evaluate((r) => window.__mk(r), raw)
}

const summary = {}

// ---- A 单击基准 ----
await reset()
const a1 = await clickSpeak(bestTarget.key)
console.log(`A 单击：点击后立即 → 按钮="${a1?.title}" 朗读条=${a1?.bar}`)
await page.waitForFunction(() => window.__p.playing.length > 0 || window.__p.rej.length > 0, { timeout: 30000 }).catch(() => { })
await page.waitForTimeout(1200)
const A = await readOut('A 单击', bestTarget.key)
console.log(JSON.stringify(A, null, 1))
summary.A = A

// ---- B 合成中再点一次（静音死路回归）----
// 第二次点击必须落在**合成窗口内**（旧实现是 3~7s 才合成完，所以取 2500ms；现在首声 ~1.5s，
// 再取 2500ms 就成"播放中暂停"了 —— 那是另一回事，各有各的断言）。这里取 600ms。
await reset()
const b1 = await clickSpeak(bestTarget.key)
await page.waitForTimeout(600)
const b2 = await clickSpeak(bestTarget.key)
console.log(`\nB 合成中再点：第1次 → ${JSON.stringify(b1)}`)
console.log(`B 合成中再点：第2次后按钮="${b2?.title}" 朗读条=${b2?.bar}${b2?.missing ? ' 【点空了】' + JSON.stringify(b2.all) : ''}`)
await page.waitForFunction(() => window.__p.playing.length > 0, { timeout: 20000 }).catch(() => { })
await page.waitForTimeout(1200)
const B = await readOut('B 合成中再点一次', bestTarget.key)
console.log(JSON.stringify(B, null, 1))
summary.B = B

// ---- C B 之后再点一次 ----
const c1 = await clickSpeak(bestTarget.key)
console.log(`\nC 再点一次：点击后按钮="${c1?.title}" 朗读条=${c1?.bar}`)
await page.waitForTimeout(3000)
const C = await readOut('C B 后再点一次', bestTarget.key)
console.log(JSON.stringify(C, null, 1))
summary.C = C

// ---- D 250ms 快速双击 ----
await reset()
await clickSpeak(bestTarget.key)
await page.waitForTimeout(250)
const d2 = await clickSpeak(bestTarget.key)
console.log(`\nD 快速双击（间隔 250ms）：第2次后按钮="${d2?.title}" 朗读条=${d2?.bar}${d2?.missing ? ' 【点空了】' + JSON.stringify(d2.all) : ''}`)
await page.waitForTimeout(12000)
const D = await readOut('D 快速双击', bestTarget.key)
console.log(JSON.stringify(D, null, 1))
summary.D = D

// ---- 上游 → 浏览器的字节时序（页面内看不到的那半边）----
console.log('\n=== /api/tts/stream 响应头（逐次）===')
console.log(JSON.stringify(streams.filter((s) => s.kind === 'response'), null, 1))
const reqs = streams.filter((s) => s.kind === 'request')
console.log(`请求次数 ${reqs.length}；响应 ${streams.filter((s) => s.kind === 'response').length}`)

/**
 * 判据（先说清楚"什么样才算通过"，否则数字好看也没意义）：
 *   · case B / D 必须有 `play 调用` 且 `真的出声` 非空 —— 改造前这两栏都是 []，
 *     界面却显示"朗读已暂停"，正是老板报的"点击不朗读"。
 *   · 系统TTS次数 = 0 —— 走的是 Pro 流式，没有偷偷回落成机械音色。
 *   · 媒体错误 = 0 且 换票状态全 200。
 *   · A 的「真的出声」应当远小于改造前的 2.8~19.1s（整包合成时长）。
 */
console.log('\n=== 判据总览 ===')
for (const k of ['A', 'B', 'C', 'D']) {
  const r = summary[k]
  if (!r) continue
  console.log(
    `${r.case}: play调用=${r.play调用ms.length} 真的出声=${JSON.stringify(r.真的出声ms)}` +
    ` 系统TTS=${r.系统TTS次数} 媒体错误=${r.媒体错误.length} 换票=${r.换票.map((x) => x.状态).join('/')}` +
    ` 朗读条="${r.最终朗读条}"`
  )
}

console.log('\n页面异常:', pageErrors.length ? pageErrors.slice(0, 3) : '无')
await browser.close()
