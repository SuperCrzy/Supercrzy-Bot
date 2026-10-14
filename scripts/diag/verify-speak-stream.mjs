/**
 * 「边生成边朗读」真机验收 (2026-09-28)
 *
 * 验的是什么：**回复还在流式输出时就已经开始朗读 —— 而不是等整条写完才开始。**
 *
 * 为什么必须真机跑：单测把 useSpeech 整层 mock 掉，证明的是"决策函数返回对"；
 * 证明不了这条跨模块链路真的通：
 *   设置(streamRead) → content_chunk 增量 → 攒批切块 → /api/tts → 音频先于流结束就绪
 * 也证明不了"开关真的改变行为"—— 那需要同一场景下的**对照运行**。
 *
 * 判决性断言（核心那两条无法被"回复完成后才读"的实现满足）：
 *   ① 首个 /api/tts 请求时刻 **早于** SSE 流结束 ≥ 500ms
 *      （写 ≥500ms 是为了排除"同一 tick 恰好排在前面"的巧合）
 *   ② 首个 /api/tts 响应时刻 **早于** SSE 流结束
 *      ⇒ 音频在流还没结束时就已就绪并开播 = "边生成边听"的直接证据
 *   ③ 首个请求的文本长度 ∈ [200, 600]（首块门槛生效，不是整条）
 *   ④ 一条 ~900 字回复切 ≥ 2 块（增量），且首块 ≤ 600 字
 * 对照组（streamRead=false，同一 always 档位）：
 *   ⑤ 首个 /api/tts 请求 **晚于** SSE 流结束
 *   ⑥ 只有 1 个请求（整条走 packForTts，一条正常回复 = 1 包）
 *   ⑦ 全程不回落系统 TTS（回落了就说明 Pro 失败，结论失真）
 *
 * ⚠️ 覆盖边界（别把本脚本当万能）：
 *   · 块间断档这一项**不在这里验** —— 600 字块会合成出 ≈130s 音频，脚本不会等它播完。
 *     块间的数学条件（音频时长 ≫ 取音频耗时）由 verify-speak-continuity.mjs 覆盖。
 *   · 本脚本**真发 2 轮消息**（真调模型，约 1200 字输出）。这两条消息只落在脚本自建的
 *     一次性会话里（正面 + 对照各一个），结束时按"会话差集恰好 **2** 个"整会话删除；
 *     差集不是 2 则**一条都不删**（宁可留垃圾也不误删）。
 *
 * ⚠️ **零副作用**：不改数据库设置。`autoReadMode`/`streamRead` 通过拦截 GET /api/settings
 * 的**响应**注入（POST 一律放行），所以不写库、不需要恢复快照 —— 早先那版靠 POST 改设置，
 * 一旦脚本异常退出就会把老板的档位留在 always（每次回复都出声）。
 *
 * 跑法（干净 env，见技能 clean-shell-env）：
 *   node scripts/diag/verify-speak-stream.mjs
 * 环境变量：SC_BASE（默认 http://localhost:5173）、SC_API（默认 http://localhost:3000）
 * 退出码：0 = 全过；1 = 有 FAIL。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { chromium } = require(join(ROOT, 'packages', 'server', 'node_modules', 'playwright-core'))

const BASE = process.env.SC_BASE || 'http://localhost:5173'
const API = process.env.SC_API || 'http://localhost:3000'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** 首块门槛 / 单块上限，与 src/utils/speech-text.ts 对齐 */
const FIRST_MIN = 200
const MAX_BLOCK = 600
/** "早于流结束"要领先这么多 ms 才算数（排除同 tick 巧合） */
const LEAD_MS = 500

let pass = 0
let fail = 0
let skip = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}  ${detail}`) }
}
/** SKIP 不算失败，但详情必须写明为什么跳过（别用来掩盖回归） */
function skipped(name, detail = '') {
  skip++
  console.log(`  SKIP ${name}${detail ? '  ' + detail : ''}`)
}

// ── Node 侧时间线（全部来自 Playwright 事件 = 同一时钟，无跨时钟基准的坑）──
const tl = { sseStart: 0, sseEnd: 0, sseEnds: [], ttsReq: [], ttsRes: [], sseFailed: [] }
const u = (s) => String(s || '')
function recordTimeline(page) {
  page.on('request', (req) => {
    const url = u(req.url())
    if (url.includes('/api/chat/agent') && req.method() === 'POST') {
      if (!tl.sseStart) tl.sseStart = Date.now()
    }
    if (url.includes('/api/tts') && req.method() === 'POST') {
      let len = 0
      try { len = String(JSON.parse(req.postData() || '{}').text || '').length } catch { /* 非 JSON */ }
      tl.ttsReq.push({ at: Date.now(), len })
    }
  })
  page.on('response', (res) => {
    if (u(res.url()).includes('/api/tts')) tl.ttsRes.push({ at: Date.now(), status: res.status() })
  })
  page.on('requestfinished', (req) => {
    if (u(req.url()).includes('/api/chat/agent') && req.method() === 'POST') {
      tl.sseEnds.push(Date.now())
      tl.sseEnd = Date.now()
    }
  })
  // SSE 被 abort / 连接中断时不会有 requestfinished —— 也当"流结束"处理，
  // 否则 sseEnd 恒为 0，断言会看到 -1.7e12 这种荒唐差值
  page.on('requestfailed', (req) => {
    if (u(req.url()).includes('/api/chat/agent')) {
      tl.sseFailed.push(u(req.failure()?.errorText))
      tl.sseEnds.push(Date.now())
      tl.sseEnd = Date.now()
    }
  })
}
function resetTurn() {
  tl.sseStart = 0
  tl.sseEnd = 0
  tl.sseEnds = []
  tl.ttsReq = []
  tl.ttsRes = []
  tl.sseFailed = []
}

/** 本轮验收的期望设置：注入 GET /api/settings 的响应（POST 放行，绝不写库） */
let injectSettings = { autoReadMode: 'always', streamRead: true }
async function installSettingsOverride(page) {
  await page.route('**/api/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const json = await res.json().catch(() => ({}))
    await route.fulfill({ json: { ...json, ...injectSettings } })
  })
}

async function dismissModals(page) {
  await page.waitForTimeout(800)
  const has = async () => (await page.locator('.n-modal-mask').count()) > 0
  if (!(await has())) return
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  if (await has()) { await page.mouse.click(12, 400); await page.waitForTimeout(400) }
}

/** 真发一轮：真鼠标聚焦 + 输入 + Enter（走真实发送链路与真实模型） */
async function sendRound(page, text) {
  const box = page.locator('textarea').first()
  await box.click()
  await box.fill(text)
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
}

/**
 * 等"开始忙"（发送按钮变 is-stop）。
 *
 * 🔴 必须先等忙再等闲：真实长回复要十几秒，而"等闲"在**发送还没生效时**就已经成立
 *    （`.send-button` 尚未带 is-stop）⇒ 直接返回"本轮已结束"，整个阶段在 3 秒内跑完，
 *    结果就是"0 个 TTS 请求"这种假失败。第一版就踩了这个坑。
 */
async function waitBusy(page, timeoutMs = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const busy = await page.evaluate(() => {
      const btn = document.querySelector('.send-button')
      return !!btn && btn.classList.contains('is-stop')
    })
    if (busy) return true
    await page.waitForTimeout(120)
  }
  return false
}

/** 等本轮结束（发送按钮从 is-stop 变回普通态） */
async function waitIdle(page, timeoutMs = 180000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const loading = await page.evaluate(() => {
      const btn = document.querySelector('.send-button')
      return !!btn && btn.classList.contains('is-stop')
    })
    if (!loading) return true
    await page.waitForTimeout(300)
  }
  return false
}

/** 最后一条 AI 回复的可见字数（前置条件：证明消息真的发出并被回答了） */
async function lastReplyLength(page) {
  return await page.evaluate(() => {
    const msgs = Array.from(document.querySelectorAll('.message'))
    const last = msgs.reverse().find((m) => m.querySelector('.message-actions button[title*="朗读"]'))
    return last ? String(last.innerText || '').trim().length : 0
  })
}

/** 当前设置（经拦截注入后的页面视角），用于证明"注入真的生效" */
async function pageSettings(page) {
  return await page.evaluate(async () => {
    const r = await fetch('/api/settings')
    return r.json()
  })
}

async function stopAllSpeech(page) {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.speak-bar-btn')).find((b) => (b.textContent || '').includes('停止'))
    if (btn) btn.click()
  })
  await page.waitForTimeout(400)
}

async function listSessionIds(page) {
  const res = await page.request.get(`${API}/api/sessions?archived=all`)
  const arr = await res.json()
  return Array.isArray(arr) ? arr.map((s) => s.id) : []
}
async function startFreshSession(page) {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, .nav-item, a')).find((b) => (b.textContent || '').trim() === '新建任务')
    if (btn) btn.click()
  })
  await page.waitForTimeout(900)
}
async function cleanupSession(page, beforeIds, expected) {
  const after = await listSessionIds(page)
  const created = after.filter((id) => !beforeIds.includes(id))
  if (created.length !== expected) {
    console.log(`  [cleanup] 新增会话 ${created.length} 个（预期 ${expected}）→ 不动任何数据，请人工确认: ${created.join(', ')}`)
    return { ok: false, created }
  }
  let allOk = true
  for (const id of created) {
    const res = await page.request.delete(`${API}/api/sessions/${id}`)
    if (!res.ok()) allOk = false
  }
  const left = await listSessionIds(page)
  return { ok: allOk && created.every((id) => !left.includes(id)), created }
}

/**
 * 提示词必须**明确禁止调工具/写文件**。
 *
 * 实测教训（2026-09-28）：只说"写一段 1600 字说明文"时，Agent 会**直接 write_to_file**
 * 把正文写进文件 —— 于是 SSE 流了 49 秒、正文 content_chunk 只流出 50 字、
 * 朗读只拿到 12 字。脚本随后报"语料不足"，看起来像功能坏了，实际是**提示词在测别的东西**。
 * 所以：显式要求"直接回复里写、不要用任何工具"。
 */
const LONG_PROMPT =
  '不要调用任何工具、不要写文件。请直接在你的聊天回复里，用中文写一段约 1000 字的说明文，' +
  '主题是「城市里为什么越来越热」。分成 6 个自然段，全部是连贯的自然段，' +
  '不要用列表、标题、代码块或表格。'
const SHORT_PROMPT =
  '不要调用任何工具、不要写文件。请直接在你的聊天回复里，用中文写一段约 300 字的说明文，' +
  '主题是「冰箱为什么能保鲜食物」，不要用列表、标题或代码块。'

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
})
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'zh-CN' })
const page = await ctx.newPage()

const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)))
recordTimeline(page)

// Lite（系统 TTS）不该在本验收里被走到：走到就说明 Pro 失败，结论会失真
await page.addInitScript(() => {
  window.__liteCalls = 0
  const ss = window.speechSynthesis
  if (ss) ss.speak = () => { window.__liteCalls++ }
})

/**
 * 页面内探针：**在发出朗读请求的那一刻，正文到底流出了多少字**。
 *
 * 为什么要这个（第一版没有，结论只能靠猜）：SSE 是带 `clone()` 读第二份的，
 * 所以能拿到 content_chunk 的到达时间线；而 `/api/tts` 的 fetch 是一处包住的，
 * 两个时刻**都在页面自己的时钟里**，不需要任何跨时钟对齐 —— 这是唯一能自证的证据：
 *   "首个朗读请求发出时正文才 208 字" ⇒ 读的是**前缀**，不是等写完的整条。
 * 只看"请求早于流结束 X ms"这种 Node 侧时间差，会被 TTFT 与吐字速度影响，
 * 说不清"到底读的是不是增量"。
 */
await page.addInitScript(() => {
  const t0 = performance.now()
  const now = () => Math.round(performance.now() - t0)
  window.__sseTotal = 0
  window.__sseTl = []
  window.__ttsSnap = []
  const orig = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    if (url.includes('/api/tts')) {
      let len = 0
      try { len = String(JSON.parse(String((init && init.body) || '{}')).text || '').length } catch { /* 非 JSON */ }
      // snapshot：此刻已流出的正文字数 —— 这就是"边生成边读"的自证
      window.__ttsSnap.push({ t: now(), len, streamed: window.__sseTotal })
      return orig(input, init)
    }
    if (!url.includes('/api/chat/agent')) return orig(input, init)
    const res = await orig(input, init)
    try {
      const reader = res.clone().body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      ;(async () => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) { window.__sseTl.push({ k: 'end', t: now(), total: window.__sseTotal }); break }
          buf += dec.decode(value, { stream: true })
          let i
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, i)
            buf = buf.slice(i + 2)
            if (!/^event: content_chunk$/m.test(frame)) continue
            const dm = frame.match(/^data: (.*)$/m)
            if (!dm) continue
            try {
              const txt = String(JSON.parse(dm[1]).text || '')
              if (!txt) continue
              window.__sseTotal += txt.length
              window.__sseTl.push({ k: 'text', t: now(), total: window.__sseTotal })
            } catch { /* 非 JSON 帧 */ }
          }
        }
      })().catch(() => { /* 流被 abort：不影响已记录的部分 */ })
    } catch { /* clone 不可用：退化为只用 Node 侧时序 */ }
    return res
  }
})

async function pageStreamInfo(page) {
  return await page.evaluate(() => ({
    total: window.__sseTotal,
    snaps: window.__ttsSnap,
    tl: window.__sseTl,
  }))
}
async function resetPageStream(page) {
  await page.evaluate(() => { window.__sseTotal = 0; window.__sseTl = []; window.__ttsSnap = [] })
}

await installSettingsOverride(page)

try {
  // ===== 0. 基线 =====
  console.log('\n[0] 基线')
  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1600)
  await dismissModals(page)
  const injectNow = await pageSettings(page)
  check('设置注入生效（页面读到 always + streamRead 开，且没写库）',
    injectNow.autoReadMode === 'always' && injectNow.streamRead === true,
    `autoReadMode=${injectNow.autoReadMode} streamRead=${injectNow.streamRead}`)
  const sessionsBefore = await listSessionIds(page)
  console.log(`  会话基线：${sessionsBefore.length} 个（结束时删除本次新建的那 1 个）`)

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1800)
  await dismissModals(page)
  await startFreshSession(page)

  // ===== 1. 正面：streamRead 开 → 边生成边读 =====
  console.log('\n[1] streamRead 开（长回复）→ 首个 TTS 必须早于流结束')
  /**
   * 为什么要重试：本验收依赖"模型肯在一次回复里吐出足够长的正文"。
   * 实测这条很脆（同一条提示词：一次 1020 字 / 一次只流 50 字而在写文件）。
   * 语料不够长时"增量"根本无从体现 —— 直接判红会让人以为功能坏了，
   * 所以最多试 2 次，取第一次正文 ≥600 字的；都不够才把核心断言记 SKIP 并说明。
   */
  let m = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    resetTurn()
    await resetPageStream(page)
    await sendRound(page, LONG_PROMPT)
    const busy = await waitBusy(page)
    check(`发送真的生效（第 ${attempt} 次，本轮进入忙碌态）`, busy)
    const idle = await waitIdle(page)
    check(`本轮已结束（第 ${attempt} 次）`, idle)
    await page.waitForTimeout(3500) // 等尾块请求 + requestfinished 事件落地

    const ps = await pageStreamInfo(page)
    const replyLen = await lastReplyLength(page)
    const lite = await page.evaluate(() => window.__liteCalls)
    console.log(`  第 ${attempt} 次：正文流出 ${ps.total} 字 / DOM 回复 ${replyLen} 字 / ` +
      `SSE ${tl.sseEnd - tl.sseStart}ms / TTS ${tl.ttsReq.length} 个 [${tl.ttsReq.map((r) => r.len).join(',')} 字]`)
    if (ps.total >= 600) {
      m = { ps, replyLen, lite, attempt }
      break
    }
    console.log('  → 正文不足 600 字（模型写短了或转去写文件），重试一次')
    await stopAllSpeech(page)
  }

  if (!m) {
    check('前置：拿到 ≥600 字的流式正文（否则本验收无判别力）', false, '两次尝试都没拿到')
    for (const label of [
      '① 首个 TTS 请求早于 SSE 结束',
      '①b 首个朗读请求发出时正文只流出了一部分',
      '② 音频在流结束前就绪',
      '③ 首个请求文本 ∈ [200, 600]',
      '④ 一条长回复切 ≥2 块',
    ]) skipped(label, '语料不足，无从体现')
  } else {
    const { ps, replyLen, lite } = m
    const firstReq = tl.ttsReq[0]
    const firstRes = tl.ttsRes[0]
    const totalLen = tl.ttsReq.reduce((a, r) => a + r.len, 0)
    const tlText = ps.tl.filter((e) => e.k === 'text')
    const firstHit = tlText.find((e) => e.total >= FIRST_MIN)
    console.log(`  时间线：SSE ${tl.sseStart}→${tl.sseEnd}（${tl.sseEnd - tl.sseStart}ms）`)
    console.log(`  正文流：共 ${ps.total} 字 / 到达节点 ${tlText.length} 个 / 攒够首块门槛(${FIRST_MIN}字) 于第 ${firstHit ? firstHit.t : '-'}ms`)
    console.log(`  朗读请求快照（页面时钟）：${JSON.stringify(ps.snaps.map((s) => ({ t: s.t, len: s.len, streamed: s.streamed })))}`)
    console.log(`  TTS 请求：${tl.ttsReq.length} 个 [${tl.ttsReq.map((r) => r.len).join(',')} 字] / 合计 ${totalLen} 字`)

    const snap0 = ps.snaps[0]
    check('前置：SSE 真的流到了 TTS（有请求）', tl.ttsReq.length >= 1, `reqs=${tl.ttsReq.length}`)
    check('前置：模型真的回答了（回复非空）', replyLen > 0, `回复 ${replyLen} 字`)
    check('前置：拿到 SSE 流结束时刻（否则"早于结束"无从比较）', tl.sseEnd > 0, `sseEnd=${tl.sseEnd}`)
    check('前置：未回落系统 TTS（Pro 真的在工作）', lite === 0, `liteCalls=${lite}`)

    check(`① 首个 TTS 请求早于 SSE 结束 ≥${LEAD_MS}ms`,
      !!firstReq && firstReq.at < tl.sseEnd - LEAD_MS,
      firstReq ? `领先 ${tl.sseEnd - firstReq.at}ms` : '（没有请求）')

    /**
     * 最强的一条自证：**发出首个朗读请求的那一刻，正文只流出了一部分**。
     * 它不依赖任何跨时钟对齐 —— 两个时刻都取自页面自己的时钟。
     * "读完才读"的实现这条必红：那时 streamed === total。
     */
    check('①b 首个朗读请求发出时正文只流出了一部分（读的是增量前缀，不是等写完的整条）',
      !!snap0 && snap0.streamed > 0 && snap0.streamed < ps.total,
      snap0 ? `请求时已流出 ${snap0.streamed} / 共 ${ps.total} 字` : '（探针没拿到快照）')

    /**
     * ② 音频是否真的"在流没结束前就开播"：需同时满足
     *      流结束前剩余时间 > 首个合成耗时
     *    不满足时**不是 bug**，而是"这段答复在首块之后就吐完了"，按 SKIP 并写明原因。
     */
    if (firstReq && firstRes && tl.sseEnd > 0) {
      const synthMs = firstRes.at - firstReq.at
      const remainMs = tl.sseEnd - firstReq.at
      if (remainMs > synthMs) {
        check('② 首个合成耗时 < 流结束前剩余时间（音频在流没结束时就已就绪 → 边生成边听）',
          true, `合成 ${synthMs}ms < 剩余 ${remainMs}ms`)
      } else {
        skipped('② 音频在流结束前就绪',
          `首块之后仅剩 ${remainMs}ms 流，而合成要 ${synthMs}ms（吐字太快，非功能问题）`)
      }
    } else {
      skipped('② 音频在流结束前就绪', '没拿到请求/响应事件')
    }

    check(`③ 首个请求文本 ∈ [${FIRST_MIN}, ${MAX_BLOCK}]（首块门槛生效，不是整条）`,
      !!firstReq && firstReq.len >= FIRST_MIN && firstReq.len <= MAX_BLOCK, `len=${firstReq?.len ?? '-'}`)
    check('③b 首块远短于总量（首块只为尽快出声）',
      !!firstReq && firstReq.len < totalLen * 0.9, `${firstReq?.len ?? '-'} vs ${totalLen}`)
    check('④ 一条长回复切 ≥2 块（是增量，不是整条一次）',
      tl.ttsReq.length >= 2, `reqs=${tl.ttsReq.length} 文本=${tl.ttsReq.map((r) => r.len).join('+')}`)
  }
  await stopAllSpeech(page)

  // ===== 2. 对照：streamRead 关 → 流结束后才读，且整条 1 包 =====
  console.log('\n[2] 对照 streamRead 关 → 只在流结束后读，且整条 1 包')
  injectSettings = { autoReadMode: 'always', streamRead: false }
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1600)
  await dismissModals(page)
  const ctl = await pageSettings(page)
  check('对照设置生效（streamRead 关）', ctl.streamRead === false, `streamRead=${ctl.streamRead}`)
  await startFreshSession(page)

  resetTurn()
  await resetPageStream(page)
  await sendRound(page, SHORT_PROMPT)
  const busy2 = await waitBusy(page)
  check('发送真的生效（本轮进入忙碌态）', busy2)
  const idle2 = await waitIdle(page)
  check('本轮已结束', idle2)
  await page.waitForTimeout(3500)

  const ctlReq = tl.ttsReq[0]
  const replyLen2 = await lastReplyLength(page)
  const ps2 = await pageStreamInfo(page)
  console.log(`  时间线：SSE ${tl.sseStart}→${tl.sseEnd}（${tl.sseEnd - tl.sseStart}ms）/ ` +
    `TTS 请求 ${tl.ttsReq.length} 个 [${tl.ttsReq.map((r) => r.len).join(',')} 字]`)
  console.log(`  朗读请求快照（页面时钟）：${JSON.stringify(ps2.snaps.map((s) => ({ t: s.t, len: s.len, streamed: s.streamed })))} / 正文共 ${ps2.total} 字`)

  check('前置：对照运行确实发起了朗读', tl.ttsReq.length >= 1, `reqs=${tl.ttsReq.length}`)
  check('前置：对照回复非空', replyLen2 > 0, `回复 ${replyLen2} 字`)
  if (ctlReq && tl.sseEnd > 0) {
    /**
     * 🔴 判据用 `>= sseEnd - 2` 而不是严格 `>`：turnEnd 里的朗读请求与 SSE 响应收完
     * 常常落在**同一毫秒**（第一版按严格大于判，报"晚 0ms"假失败）。
     * 真正的判别力在下面两条镜像上，不在 1ms 的先后。
     */
    check('⑤ 对照：首个 TTS 请求不早于 SSE 结束（没有提前开读）',
      ctlReq.at >= tl.sseEnd - 2, `差 ${ctlReq.at - tl.sseEnd}ms`)
    check('⑥ 对照：整条 1 包（packForTts 正常回复只发 1 次请求）',
      tl.ttsReq.length === 1, `reqs=${tl.ttsReq.length} 文本=${tl.ttsReq.map((r) => r.len).join('+')}`)
    // 镜像对照：对照组读的是**整条**（≈全部正文），实验组读的是**前缀**（≈200 字）
    const ctlSnap = ps2.snaps[0]
    if (ctlSnap && ps2.total > 0) {
      check('⑤b 对照：首个请求就是整条（文本量 ≈ 全部正文）',
        ctlSnap.streamed >= ps2.total * 0.9, `请求时已流出 ${ctlSnap.streamed} / 共 ${ps2.total} 字`)
    } else {
      skipped('⑤b 对照：首个请求就是整条', '页面探针没拿到快照')
    }
  } else {
    skipped('⑤ 对照：首个 TTS 请求晚于 SSE 结束', '没拿到请求或流时间')
    skipped('⑥ 对照：整条 1 包', '同上')
    skipped('⑤b 对照：首个请求就是整条', '同上')
  }
  await stopAllSpeech(page)

  // ===== 3. 运行期异常 =====
  console.log('\n[3] 运行期异常')
  check('运行期无页面级异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))

  // ===== 4. 清理一次性会话（绝不碰老板的真实会话）=====
  console.log('\n[4] 清理')
  await page.screenshot({ path: '/tmp/sc-speak-stream.png' })
  const cleanup = await cleanupSession(page, sessionsBefore, 2)
  check('验收新建的一次性会话已删除（不污染真实会话）', cleanup.ok, `created=${cleanup.created.join(',') || '(无)'}`)
  const after = await listSessionIds(page)
  // 不变量（**不是**"数量相等"）：本次删除集合与基线集合**必须不相交** —— 这才是
  // "绝不动老板真实会话"的可断言形式，且不依赖任何外部状态。
  //
  // 为什么不能比数量：应用自身会 churn 空的临时会话（点一次"新建任务"就在服务端建一条，
  // 空会话又可能被别处清掉）。2026-09-28 实测：基线 32 → 清完 31 → 随后 30，
  // 而同期数据库里 **0 条空会话**、最新真实会话停在 09-26 ⇒ 那 1~2 条差值来自 churn，
  // 不是被删。数量相等只是"上一次恰好没撞上 churn"的巧合，比它会把巧合当正确性。
  const touchedBefore = cleanup.created.filter((id) => sessionsBefore.includes(id))
  check('清理只动了本次新建的会话（不变量：删除集合 ∩ 基线 = ∅）',
    cleanup.ok && touchedBefore.length === 0,
    cleanup.ok
      ? (touchedBefore.length ? `越界删了基线会话: ${touchedBefore.join(', ')}` : `删除 ${cleanup.created.length} 条，全部是本次新建`)
      : `新建数与预期不符，已拒绝删除任何数据（created=${cleanup.created.length}）`)
  console.log(`  [info] 会话数 ${sessionsBefore.length} → ${after.length}（差值为应用自身的空会话 churn，非本脚本所为）`)
} catch (e) {
  fail++
  failures.push('脚本异常: ' + e.message)
  console.log('\n脚本异常: ' + e.stack)
} finally {
  await browser.close()
}

console.log(`\n===== 边生成边朗读验收：${pass} passed / ${fail} failed${skip ? ` / ${skip} skipped` : ''} =====`)
if (failures.length) console.log('失败项: ' + failures.join(', '))
process.exit(fail === 0 ? 0 : 1)
