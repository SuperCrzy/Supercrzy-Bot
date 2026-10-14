/**
 * 朗读连贯性 · 真机验收 (2026-09-28)
 *
 * 验的是什么：**朗读中途不许出现"读完一段停几秒"的空档。**
 *
 * 背景（老板报的症状）：读完第一段要停几秒才接着读。根因不是网络抖一下那么简单，
 * 而是两条叠加：
 *   ① 前端按句/按段切分 → 一条 3 段回复 = 3 次独立合成请求；
 *   ② 合成耗时几乎固定（握手主导），所以每段之间都要**等下一次合成**才出声。
 *
 * 修复后的判据（本脚本钉死的就是这几条）：
 *   · **请求数 == 该文本应有的包数**（`packForTts`，单包上限 2000 字）——
 *     按句/按段切会让请求数变成几十上百，这条断言抓的就是那个回归
 *   · 音频时长 > 取音频耗时（实时率 > 1）—— 这是"流水线追得上"的数学条件；
 *     追不上就一定会断档，所以这条比"听感"更可靠
 *   · 段间静音空档 < 300ms —— ⚠️ **只在真的播放到第 2 包时才成立**：
 *     单包（或音频太长没播到第 2 包）时这一项记 **SKIP**，不记 ok
 *     （报 ok 就是恒真断言，会让人以为"空档已被验证"）
 *   · 首声延迟（**由页面在点击那一刻打点**起算）< 8s
 *
 * ⚠️ 覆盖边界（别把本脚本当成万能）：段间空档这一项在真实数据上**很难有判别力** ——
 * 2000 字的包会合成出 7 分钟音频，脚本不会等它播到第 2 包。要专门验多包边界，
 * 得用 `page.route` 把 `/api/tts` 换成一段几秒的假音频，让多包快速连播。
 * 目前真正的防线是"请求数 == 应有包数"那条。
 *
 * ⚠️ 别把断言写成"请求数 ≤ 3"之类 —— 它必须能抓住"退化回按句切"。
 *    也别只断言"能出声"：按句切也能出声，只是会断档。
 *
 * 不写任何用户数据：只点已有消息的「朗读」按钮，不发消息、不改设置。
 *
 * 跑法：node scripts/diag/verify-speak-continuity.mjs
 */
import { createRequire } from 'node:module'
// 项目根由脚本位置推导 —— 不许写死本机绝对路径（对外发布后会指向不存在的目录，
// 且会把开发机的用户名带进公开仓库）。
import { fileURLToPath as __f2p } from 'node:url'
import { dirname as __dn, join as __j } from 'node:path'
const __ROOT = __j(__dn(__f2p(import.meta.url)), '../..')
const require = createRequire(__ROOT + '/packages/server/')
const { chromium } = require(__ROOT + '/packages/server/node_modules/playwright-core')

const BASE = 'http://localhost:5173'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
/** 段间空档容忍上限（ms）：低于这个值听不出断裂 */
const GAP_TOLERANCE_MS = 300
/** 首声延迟上限（ms） */
const FIRST_SOUND_LIMIT_MS = 8000
/** 音频超过这个长度就不等"播完"了（记 SKIP，别把脚本拖死或假失败） */
const WAIT_AUDIO_LIMIT_SEC = 40

/** 单包上限，与 `src/utils/speech-text.ts` 的 `TTS_PACK_MAX_CHARS` 对齐 */
const PACK_MAX_CHARS = 2000

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, kind: 'assert' })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`)
}
/** SKIP 不算失败，但详情必须写明为什么跳过（别用来掩盖回归） */
function skip(label, detail = '') {
  results.push({ label, ok: true, kind: 'skip' })
  console.log(`  SKIP ${label}${detail ? '  ' + detail : ''}`)
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
})
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })

// ── 探针：记录 fetch(/api/tts) 与 Audio 事件的时间线（全部以页面内 performance.now() 为基准）
await page.addInitScript(() => {
  const t0 = performance.now()
  window.__tl = []
  const push = (o) => window.__tl.push(Object.assign({ t: Math.round(performance.now() - t0) }, o))
  // 供外部"打点"用：点击时刻必须由**页面内**记，否则 Node 侧的时间与原页面时间两套基准，
  // 首声延迟会平白多出"页面加载 + 定位消息"的那几秒（2026-09-28 踩到：实测虚高 ~3s）。
  window.__mark = (k) => push({ k })

  const origFetch = window.fetch.bind(window)
  let seq = 0
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || ''
    if (!url.includes('/api/tts')) return origFetch(input, init)
    const id = ++seq
    let textLen = 0
    try { textLen = String(JSON.parse(String(init?.body || '{}')).text || '').length } catch {}
    push({ k: 'req', id, textLen })
    try {
      const res = await origFetch(input, init)
      push({ k: 'res', id, status: res.status })
      return res
    } catch (e) {
      push({ k: 'res-err', id, msg: String(e?.message || e) })
      throw e
    }
  }

  const RealAudio = window.Audio
  window.Audio = function (url) {
    const el = new RealAudio(url)
    push({ k: 'audio-new' })
    el.addEventListener('loadedmetadata', () => push({ k: 'meta', dur: Number(el.duration.toFixed(2)) }))
    el.addEventListener('playing', () => push({ k: 'playing' }))
    el.addEventListener('ended', () => push({ k: 'ended' }))
    el.addEventListener('error', () => push({ k: 'audio-error' }))
    return el
  }

  // Lite（系统 TTS）不该在本验收里被走到：走到就说明 Pro 失败了，结论会失真
  window.__liteCalls = 0
  const ss = window.speechSynthesis
  if (ss) ss.speak = () => { window.__liteCalls++ }
})

const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)))

async function openChat() {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(2400)
  if (await page.locator('.n-modal-mask').count() > 0) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
  }
  await page.waitForTimeout(400)
}

// ══════════════════════════════════════════════════════════
console.log('\n[1] 选一条多段回复并朗读')
// ══════════════════════════════════════════════════════════
await openChat()

const cands = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('.message-actions button'))
    .filter((b) => (b.getAttribute('title') || '').includes('朗读'))
  return btns.map((b, i) => {
    const msg = b.closest('.message') || b.closest('[class*="message"]')
    const txt = (msg?.innerText || '').trim()
    return { i, len: txt.length, paras: txt.split(/\n{2,}/).length, txt }
  })
})
check('页面上有可朗读的消息（前置条件）', cands.length > 0, `messages=${cands.length}`)

/**
 * 选样规则（2026-09-28 修）：
 *   ① 优先"多段 + 短"（正文 40~600 字）—— 这类消息才是"段间空档"的高发区
 *      （短段落音频只有 3s 左右，最容易等不到下一包）
 *   ② **别选超长报告**：一条 2300 字的回复会合成出 5 分钟音频，脚本要等 5 分钟，
 *      而且"只发 1 次请求"的断言对它本来就不成立（该切 2 包）
 *   ③ 已知老样本（"有什么我可以帮你的"）优先，便于跨次对比
 */
const shortMultiPara = cands.filter((c) => c.paras >= 2 && c.len >= 40 && c.len <= 600)
const pick =
  shortMultiPara.find((c) => c.txt.includes('有什么我可以帮你的')) ||
  shortMultiPara[0] ||
  cands.find((c) => c.paras >= 2) ||
  cands[0]
if (!pick) {
  console.log('没有可朗读消息，无法继续')
  await browser.close()
  process.exit(1)
}
console.log(`  选中 [${pick.i}] len=${pick.len} paras=${pick.paras}`)
console.log(`  正文前 60 字: ${JSON.stringify(pick.txt.slice(0, 60).replace(/\s+/g, ' '))}`)

// 分段数 ≥ 2 才有"段间空档"可言。若语料里没有多段消息，本验收会失去判别力 —— 明说。
check('样本是多段回复（否则验不出"段间空档"）', pick.paras >= 2, `paras=${pick.paras}`)

const clickAt = Date.now()
await page.evaluate((i) => {
  const btns = Array.from(document.querySelectorAll('.message-actions button'))
    .filter((b) => (b.getAttribute('title') || '').includes('朗读'))
  window.__mark?.('click') // 点击时刻按**页面时间**记，供首声延迟使用
  btns[i]?.click()
}, pick.i)

// 等到信息够了为止：
//   · 拿到 ended → 结束
//   · 已在播放且音频比等待上限还长 → 立即结束（别为一条 5 分钟的音频干等）
//   · 出声前 12s / 出声后 45s 无新事件 → 兜底结束
// ⚠️ 不要用一个固定的小窗口收尾 —— 单包会把整条读成一条几十秒的音频，
//    "12s 无事件"会在音频播到一半时误判结束，然后假失败在「播完了」这条上。
let last = 0
let idle = 0
const deadline = Date.now() + 180000
let stopReason = 'deadline'
while (Date.now() < deadline) {
  await page.waitForTimeout(500)
  const tl = await page.evaluate(() => window.__tl)
  if (tl.some((e) => e.k === 'ended' || e.k === 'audio-error')) { stopReason = 'ended'; break }
  const hasPlaying = tl.some((e) => e.k === 'playing')
  const durSec = tl.filter((e) => e.k === 'meta').reduce((a, m) => a + (m.dur || 0), 0)
  if (hasPlaying && durSec > WAIT_AUDIO_LIMIT_SEC) { stopReason = `音频 ${durSec.toFixed(0)}s > 上限`; break }
  if (tl.length === last) idle += 1
  else { idle = 0; last = tl.length }
  const idleLimit = hasPlaying ? 90 : 24
  if (idle >= idleLimit) { stopReason = 'idle'; break }
}
console.log(`  [等待结束: ${stopReason}]`)

const tl = await page.evaluate(() => window.__tl)
const liteCalls = await page.evaluate(() => window.__liteCalls)

// ══════════════════════════════════════════════════════════
console.log('\n[2] 时间线')
// ══════════════════════════════════════════════════════════
for (const e of tl) {
  const extra = []
  if (e.status) extra.push('status=' + e.status)
  if (e.textLen) extra.push(`text=${e.textLen}字`)
  if (e.dur !== undefined) extra.push('dur=' + e.dur + 's')
  if (e.msg) extra.push(e.msg)
  console.log(`  ${String(e.t).padStart(6)}ms  ${e.k.padEnd(11)} ${extra.join(' ')}`)
}

const reqs = tl.filter((e) => e.k === 'req')
const oks = tl.filter((e) => e.k === 'res' && e.status === 200)
const metas = tl.filter((e) => e.k === 'meta')
const playings = tl.filter((e) => e.k === 'playing')
const ended = tl.filter((e) => e.k === 'ended')

// 段间空档：上一次 ended → 下一次 playing
const gaps = []
let lastEnd = null
for (const e of tl) {
  if (e.k === 'ended') lastEnd = e.t
  if (e.k === 'playing' && lastEnd !== null) {
    gaps.push(e.t - lastEnd)
    lastEnd = null
  }
}

// 取音频耗时：req → 对应 res
const reqAt = new Map()
const fetchDurs = []
for (const e of tl) {
  if (e.k === 'req') reqAt.set(e.id, e.t)
  if ((e.k === 'res' || e.k === 'res-err') && reqAt.has(e.id)) {
    fetchDurs.push(e.t - reqAt.get(e.id))
    reqAt.delete(e.id)
  }
}

// ══════════════════════════════════════════════════════════
console.log('\n[3] 断言')
// ══════════════════════════════════════════════════════════
check('Pro 通道真的在工作（没有回落系统 TTS，否则本验收无意义）',
  liteCalls === 0, `liteCalls=${liteCalls}`)
check('成功拿到音频', oks.length >= 1, `200 响应=${oks.length}`)
check('音频真的开播了', playings.length >= 1, `playing 事件=${playings.length}`)

/**
 * 请求数断言 —— **不能写死 1**（2026-09-28 修）：
 * 单包上限是 2000 字，超过就该分包。写死 `=== 1` 会在脚本选到长报告时假失败
 * （实测选到一条 2298 字的报告，正确行为就是 2 包，却被判红）。
 *
 * 真正的判据是：**请求数 == 该文本应有的包数**。而"按句/按段切"会让请求数
 * 变成几十上百，这条断言依然抓得住回归 —— 详情里同时给出"按句切会发多少次"作为对照。
 */
const textLens = reqs.map((r) => r.textLen)
const totalText = textLens.reduce((a, b) => a + b, 0)
const expectedPacks = Math.max(1, Math.ceil(totalText / PACK_MAX_CHARS))
const sentenceSplitWouldBe = (pick.txt.match(/[。！？!?；;…]/g) || []).length || 1
check(`请求数 == 该文本应有的包数（${expectedPacks} 包；按句/按段切会退化成 ~${sentenceSplitWouldBe} 次）`,
  reqs.length === expectedPacks, `requests=${reqs.length} texts=${JSON.stringify(textLens)}`)

const audioSec = metas.reduce((a, m) => a + (m.dur || 0), 0)
const fetchMs = fetchDurs.reduce((a, b) => a + b, 0)
check('音频时长 > 取音频耗时（实时率>1，流水线追得上的数学条件）',
  audioSec * 1000 > fetchMs, `音频=${audioSec.toFixed(1)}s vs 取音频=${fetchMs}ms`)

const worstGap = gaps.length ? Math.max(...gaps) : 0
/**
 * ⚠️ **没有段间边界时不能判 ok**（2026-09-28 修）：单包播放根本不存在"段间空档"，
 * 报 `ok` 是恒真断言 —— 会让人误以为"空档已被验证"。没边界就记 SKIP 并把原因写清楚。
 */
if (gaps.length) {
  check(`段间静音空档 < ${GAP_TOLERANCE_MS}ms`, gaps.every((g) => g < GAP_TOLERANCE_MS),
    gaps.map((g) => g + 'ms').join(', '))
} else {
  skip(`段间静音空档 < ${GAP_TOLERANCE_MS}ms`,
    reqs.length > 1 ? `本次没播放到第 2 包（音频太长，提前收尾）` : '单包，不存在段间边界')
}

/**
 * 首声延迟 —— **必须相对"点击时刻"量，而不是相对页面加载**（2026-09-28 修）。
 * 点击时刻由页面自己打点（`window.__mark('click')`）；拿 Node 侧时钟去减，会平白多出
 * "页面加载 + 找到消息"那几秒（实测虚高约 3s，直接把 5.8s 报成 8.8s 假失败）。
 */
const clickEvt = tl.find((e) => e.k === 'click')
const firstSound = playings.length && clickEvt ? playings[0].t - clickEvt.t : Date.now() - clickAt
check(`首声延迟 < ${FIRST_SOUND_LIMIT_MS}ms`, firstSound < FIRST_SOUND_LIMIT_MS, `${firstSound}ms`)

// ⚠️ 音频长度是内容决定的：等"播完"要有上限，否则 5 分钟的音频会把脚本拖死/假失败
const endedWithin = ended.length >= 1
if (endedWithin) check('播完了（不是"出声就断"）', true, `ended=${ended.length}`)
else if (audioSec > WAIT_AUDIO_LIMIT_SEC) {
  skip('播完了（不是"出声就断"）', `音频 ${audioSec.toFixed(0)}s 超出本脚本等待上限 ${WAIT_AUDIO_LIMIT_SEC}s`)
} else {
  check('播完了（不是"出声就断"）', false, `音频仅 ${audioSec.toFixed(1)}s 却没等到 ended`)
}
check('运行期无页面级 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

await browser.close()

const passed = results.filter((r) => r.ok).length
const skipped = results.filter((r) => r.kind === 'skip').length
console.log(`\n===== 朗读连贯性验收：${passed} passed / ${results.length - passed} failed${skipped ? ` / ${skipped} skipped` : ''} =====`)
console.log(`摘要: 请求 ${reqs.length} 次（文本 ${textLens.join('+') || 0} 字）/ 音频 ${audioSec.toFixed(1)}s / 取音频 ${fetchMs}ms / 最大空档 ${worstGap}ms / 首声 ${firstSound}ms`)
if (passed !== results.length) {
  console.log('失败项: ' + results.filter((r) => !r.ok).map((r) => r.label).join(' / '))
  process.exit(1)
}
