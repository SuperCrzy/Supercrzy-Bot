/**
 * 朗读音色降级提示 · 真机验收 (2026-09-28)
 *
 * 验的是什么：**Pro 音色不可用时，界面必须说实话。**
 *
 * 背景：2026-09-28 老板问"为什么朗读音色是机械化的"。真相是 `/api/tts` 的 wss 握手
 * 被中间盒 RST（实测单次成功率 ~25%），而 useSpeech 里 `proDisabled = true` 是**永久**开关，
 * 失败一次整个会话都回落系统 TTS「婷婷」（拼接式），且**零提示** ——
 * 用户只会以为"音色怎么这么机械"，不会想到"朗读降级了"。本脚本钉死改造后的三条行为：
 *
 *   ① 失败 → 浮条上出现「音色降级：正在用系统音色」（而不是静默变难听）
 *   ② 冷却期内不再空试 Pro（省掉注定失败的那次请求），但仍要出声（走 Lite）
 *   ③ 成功 → 提示必须消失（对照，否则"提示恒显示"也会让 ① 全绿）
 *
 * 另外顺带钉死 Lite 音色的优选：命中的系统音色**不该是「婷婷」**（原来是首选项 = 最机械的那个）。
 *
 * 不写任何用户数据：只点已有消息的「朗读」按钮，不发消息、不改设置。
 *
 * 跑法：node scripts/diag/verify-speak-degrade.mjs
 */
import { createRequire } from 'node:module'
const require = createRequire('/Users/chaojiphonekuang/Downloads/supercrzy/supercrzy-agent/packages/server/')
const { chromium } = require('/Users/chaojiphonekuang/Downloads/supercrzy/supercrzy-agent/packages/server/node_modules/playwright-core')

const BASE = 'http://localhost:5173'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`)
}

/** 点第 idx 个「朗读」按钮；返回是否点到 */
async function clickReadAloud(page, idx) {
  return page.evaluate((i) => {
    const btns = Array.from(document.querySelectorAll('.message-actions button'))
      .filter((b) => (b.getAttribute('title') || '').includes('朗读'))
    if (!btns[i]) return false
    btns[i].click()
    return true
  }, idx)
}

async function barState(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.speak-bar')
    const hint = document.querySelector('.speak-bar-hint')
    return {
      barVisible: !!bar && bar.getClientRects().length > 0,
      hintVisible: !!hint && hint.getClientRects().length > 0,
      hintText: hint ? (hint.textContent || '').trim() : '',
      barText: bar ? (bar.textContent || '').replace(/\s+/g, ' ').trim() : '',
    }
  })
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

// ── 探针：不让 Lite 真播（避免 onend 提前复位浮条），但**保留真实 getVoices**
//    —— 音色优选顺序必须拿真机的音色表来验，不能喂假数据。
await page.addInitScript(() => {
  window.__liteCalls = []
  const ss = window.speechSynthesis
  if (ss) {
    ss.speak = (u) => {
      window.__liteCalls.push({ name: u.voice?.name || null, lang: u.lang, len: (u.text || '').length })
      // 故意不触发 onend：让 speakingId 保持，浮条留在页面上供断言
    }
    ss.pause = () => {}
    ss.resume = () => {}
    ss.cancel = () => {}
  }
  // 替换 Audio：成功路径只要走通状态机即可，不需要真解码（否则 headless 里事件不确定）
  window.__audioPlay = 0
  window.Audio = class {
    constructor(url) { this.src = url; this.onended = null; this.onerror = null }
    play() { window.__audioPlay++; return Promise.resolve() }
    pause() {}
  }
  window.__ttsReqs = 0
})

let pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e?.message || e)))
// ⚠️ 在 Node 侧计数，别在 request 回调里 page.evaluate —— 那是异步竞态的（读到的可能是旧值）
let ttsReqs = 0
page.on('request', (r) => {
  if (r.method() === 'POST' && r.url().includes('/api/tts')) ttsReqs++
})

async function openChat() {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(2200)
  if (await page.locator('.n-modal-mask').count() > 0) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
  }
  await page.waitForTimeout(400)
}

// ══════════════════════════════════════════════════════════
console.log('\n[1] 失败路径：/api/tts 恒 400（模拟上游 RST）')
// ══════════════════════════════════════════════════════════
await page.route('**/api/tts', (route) => route.fulfill({
  status: 400,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify({ error: '语音合成失败: read ECONNRESET' }),
}))
await openChat()

const readBtns = await page.evaluate(() => document.querySelectorAll('.message-actions button').length)
check('页面上有可朗读的消息（前置条件）', readBtns > 0, `buttons=${readBtns}`)

const clicked1 = await clickReadAloud(page, 0)
check('点到第 1 条消息的「朗读」', clicked1)
await page.waitForTimeout(1200)

const s1 = await barState(page)
check('朗读浮条已现身', s1.barVisible, JSON.stringify(s1))
check('降级提示已出现（不再静默变难听）', s1.hintVisible)
check('降级提示文案 = i18n 实渲染', s1.hintText.includes('音色降级'), `text="${s1.hintText}"`)

const lite1 = await page.evaluate(() => window.__liteCalls)
check('失败后确实走了 Lite（系统 TTS 被调用）', lite1.length >= 1, JSON.stringify(lite1.slice(0, 1)))

// 判决性对照：冷却期内换一条消息朗读，**不该**再发一次注定失败的请求
const reqBefore = ttsReqs
const clicked2 = await clickReadAloud(page, 1)
await page.waitForTimeout(1200)
const reqAfter = ttsReqs
check('点到第 2 条消息的「朗读」', clicked2)
check('冷却期内不再空试 Pro（没有新增 /api/tts 请求）',
  reqAfter === reqBefore, `before=${reqBefore} after=${reqAfter}`)
const lite2 = await page.evaluate(() => window.__liteCalls)
check('但声音不能断：第 2 条照样走了 Lite', lite2.length >= 2, `liteCalls=${lite2.length}`)
const s2 = await barState(page)
check('第 2 条仍在降级态（提示保持显示）', s2.hintVisible)

// ══════════════════════════════════════════════════════════
console.log('\n[2] 成功路径（重新加载清掉冷却 + /api/tts 返回 200）')
// ══════════════════════════════════════════════════════════
await page.unroute('**/api/tts')
await page.route('**/api/tts', (route) => route.fulfill({
  status: 200,
  contentType: 'audio/mpeg',
  body: Buffer.from('ID3fake-mp3-payload-for-state-machine'),
}))
await openChat()

const liteBefore = (await page.evaluate(() => window.__liteCalls)).length
const clicked3 = await clickReadAloud(page, 0)
await page.waitForTimeout(1200)
const s3 = await barState(page)
const liteAfter = (await page.evaluate(() => window.__liteCalls)).length

check('点到「朗读」', clicked3)
check('浮条现身（说明真的在朗读，不是"什么都没发生所以没有提示"）', s3.barVisible, JSON.stringify(s3))
check('成功路径下**不出现**降级提示（对照，防"提示恒显示"）', !s3.hintVisible)
check('成功路径没有走 Lite（走的确实是 Pro 通道）', liteAfter === liteBefore,
  `lite ${liteBefore} → ${liteAfter}`)
const audioPlay = await page.evaluate(() => window.__audioPlay)
check('Pro 音频真的被播放器接手了', audioPlay >= 1, `audioPlay=${audioPlay}`)

// ══════════════════════════════════════════════════════════
console.log('\n[3] Lite 优选音色（拿真机音色表验，不是喂假数据）')
// ══════════════════════════════════════════════════════════
await page.unroute('**/api/tts')
await page.route('**/api/tts', (route) => route.fulfill({
  status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'read ECONNRESET' }),
}))
await openChat()
await clickReadAloud(page, 0)
await page.waitForTimeout(1200)
const liteVoices = await page.evaluate(() => window.__liteCalls.map((c) => c.name))
check('失败回落时确实指定了系统音色', liteVoices.length >= 1 && !!liteVoices[0], JSON.stringify(liteVoices))
check('命中的不是拼接式老音色「婷婷」（优选表重排生效）',
  !String(liteVoices[0] || '').includes('婷婷'), `picked="${liteVoices[0]}"`)

console.log('\n[4] 运行期异常')
check('运行期无页面级 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

await browser.close()

const passed = results.filter((r) => r.ok).length
console.log(`\n===== 朗读降级验收：${passed} passed / ${results.length - passed} failed =====`)
if (passed !== results.length) {
  console.log('失败项: ' + results.filter((r) => !r.ok).map((r) => r.label).join(' / '))
  process.exit(1)
}
