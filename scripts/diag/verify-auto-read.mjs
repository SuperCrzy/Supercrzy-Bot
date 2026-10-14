/**
 * 「自动朗读」真机验收 (2026-09-27)
 *
 * 验的是什么：**回复完成时，到底会不会念出来 —— 且不该念的时候绝不出声。**
 *
 * 为什么不能只跑单测：`shouldAutoRead()` 的 16 例单测证明的是"给定四个输入，返回值对"；
 * 证明不了这条跨模块链路通：
 *   设置页下拉 → form → appStore → 本轮结束出口 finishTurn → useSpeech.speak → 真实 /api/tts
 * 也证明不了"前台/后台"在**真浏览器**里读出来的是什么。
 *
 * 观测手段（两个独立通道）：
 *   · 界面通道：输入框上方「正在朗读」浮条是否出现 / 消失
 *   · 网络通道：拦 `/api/tts` 的 **POST body**（这是"真的开始念了"的唯一硬证据）
 *   · 音频通道：代理 AudioContext 数振荡器（用来证明"修了提示音在本轮失败时乱响"这个 bug）
 *
 * 关键手法：用 `page.route` 把 `/api/chat/agent` 换成**确定性 SSE 流**，
 * 不花 token、不依赖模型回复内容，还能精确构造"断流（无 done）"这种失败场景。
 *
 * 判决性断言：
 *   · background 档 + 后台 → **有** /api/tts 请求；同样档位 + 前台 → **无**（否则"只看档位不看前台"也会全绿）
 *   · 断流（未收到 done）+ always 档 + 后台 → **既无 tts 请求、也无振荡器**
 *     （此前 attemptStream 的返回值被丢掉，中断也会"叮"一声 —— 本轮顺带修掉）
 *
 * 用法（干净 env，见技能 clean-shell-env）：
 *   node scripts/diag/verify-auto-read.mjs
 * 环境变量：SC_BASE（默认 http://localhost:5173）、SC_API（默认 http://localhost:3000）
 * 退出码：0 = 全过；1 = 有 FAIL。
 *
 * ⚠️ 浏览器自动播放策略：脚本用真实鼠标点「发送」建立**粘性激活**（sticky activation），
 * 未加 `--autoplay-policy` 覆盖 —— 因为"用户在真实环境里能不能自动出声"正是要验的东西之一。
 * 若本机 headless Chrome 拦截了自动播放，`[2]` 会红；那属于环境问题而非产品问题，
 * 装机验收必须在真桌面端再跑一遍（Electron 无该限制）。
 *
 * 注意：脚本会临时改动本机设置（自动朗读档位 / 提示音开关），结束时按进入时的快照恢复。
 * 它还会**真发 6 轮消息**（SSE 被 stub，不花 token、不调模型）—— 这些消息只落在脚本
 * 自己新建的**一次性会话**里，结束时整会话删除；若差集不是恰好 1 个则不做任何删除并提示人工处理。
 * （第一版没隔离会话，12 条验收消息写进了老板的真实会话 —— 已清理，脚本已修。）
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

let pass = 0
let fail = 0
const failures = []
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`) }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}  ${detail}`) }
}

async function getSettings(page) {
  const res = await page.request.get(`${API}/api/settings`)
  return await res.json()
}
async function postSettings(page, body) {
  const res = await page.request.post(`${API}/api/settings`, { data: body })
  return res.status()
}

/** 收集发往 /api/tts 的 POST body（"真的开始念了"的硬证据） */
function recordTtsPosts(page) {
  const posts = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/tts')) {
      try { posts.push(JSON.parse(req.postData() || '{}')) } catch { posts.push({}) }
    }
  })
  return posts
}

/** 关掉自动弹出的更新日志 modal（遮罩会吃掉真实鼠标事件；新 profile 必弹） */
async function dismissModals(page) {
  await page.waitForTimeout(900)
  const has = async () => await page.locator('.n-modal-mask').count() > 0
  if (!(await has())) return false
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  if (!(await has())) return true
  await page.mouse.click(12, 400)
  await page.waitForTimeout(400)
  return !(await has())
}

/** 读当前**可见** tab 面板文本（不可见面板的 innerText 恒为 ''） */
async function visiblePaneText(page) {
  return await page.evaluate(() => {
    const vis = Array.from(document.querySelectorAll('.n-tab-pane')).find((p) => p.getClientRects().length > 0)
    return vis ? vis.innerText : ''
  })
}

/** 打开某设置行里的下拉 */
async function openSelect(page, rowLabel) {
  return await page.evaluate((label) => {
    const row = Array.from(document.querySelectorAll('.setting-row')).find((r) => (r.textContent || '').includes(label))
    const sel = row?.querySelector('.n-base-selection')
    if (!sel) return false
    sel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }, rowLabel)
}

/** 读某行下拉当前显示值 */
async function selectedLabel(page, rowLabel) {
  return await page.evaluate((label) => {
    const row = Array.from(document.querySelectorAll('.setting-row')).find((r) => (r.textContent || '').includes(label))
    return row?.querySelector('.n-base-selection-label')?.textContent?.trim() || ''
  }, rowLabel)
}

/** 点某个选项的名字（只在可见下拉里找） */
async function clickOptionName(page, optionText) {
  return await page.evaluate((text) => {
    const menu = Array.from(document.querySelectorAll('.n-base-select-menu')).find((m) => m.getClientRects().length > 0)
    const opt = Array.from(menu?.querySelectorAll('.n-base-select-option') || []).find((o) => (o.textContent || '').includes(text))
    if (!opt) return false
    opt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }, optionText)
}

/** 可见下拉里的选项文本 */
async function visibleOptionTexts(page) {
  return await page.evaluate(() => {
    const menu = Array.from(document.querySelectorAll('.n-base-select-menu')).find((m) => m.getClientRects().length > 0)
    return Array.from(menu?.querySelectorAll('.n-base-select-option') || []).map((o) => (o.textContent || '').trim())
  })
}

/** 设置页某行下拉整体切到某档（点开 → 点名字），避开"下拉展开态"残留 */
async function pickAutoRead(page, label) {
  await openSelect(page, '自动朗读')
  await page.waitForTimeout(500)
  const ok = await clickOptionName(page, label)
  await page.waitForTimeout(900) // 等防抖落库（600ms）
  return ok
}

/**
 * 把档位切到某档并回到聊天页。
 *
 * ⚠️ 必须走 UI，不能只 POST /api/settings：`appStore.autoReadMode` 只在页面加载时读一次，
 * 后端值改了而页面里的 store 还是旧值 ⇒ 判定用的是**旧档位**。
 * 实测踩到过：步骤 [1] 用 UI 选了 always，后面步骤改用 POST 切 background/off，
 * 页面里仍是 always → 断言"不该朗读"全红（看起来像功能坏了，其实是脚本测错了东西）。
 */
async function setAutoReadMode(page, label) {
  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1400)
  await dismissModals(page)
  const switched = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('.n-tabs-tab')).find((e) => (e.textContent || '').includes('语音与声音'))
    if (!t) return false
    t.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })
  await page.waitForTimeout(600)
  const picked = switched ? await pickAutoRead(page, label) : false
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1200)
  await dismissModals(page)
  return picked
}

/**
 * 把 /api/chat/agent 换成确定性 SSE 流。
 * `withDone: false` 用来构造"断流"（收不到 done ⇒ attemptStream 返回 false）。
 */
async function stubAgentStream(page, { text = '', withDone = true, events = null } = {}) {
  await page.unroute('**/api/chat/agent').catch(() => {})
  await page.route('**/api/chat/agent', async (route) => {
    const list = events || [
      ...(text ? [{ type: 'content_chunk', data: { text } }] : []),
      ...(text ? [{ type: 'content', data: { content: text } }] : []),
      ...(withDone ? [{ type: 'done', data: {} }] : []),
    ]
    const body = list
      .map((e, i) => `id: ${i + 1}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`)
      .join('')
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body,
    })
  })
}

/** 真发一轮：真鼠标聚焦 + 输入 + Enter（建立粘性激活，同时走真实发送链路） */
async function sendRound(page, text) {
  const box = page.locator('textarea').first()
  await box.click()
  await box.fill(text)
  await page.waitForTimeout(150)
  await page.keyboard.press('Enter')
}

/** 等本轮结束（isLoading 转 false） */
async function waitIdle(page, timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const loading = await page.evaluate(() => {
      const btn = document.querySelector('.send-button')
      return !!btn && btn.classList.contains('is-stop')
    })
    if (!loading) return true
    await page.waitForTimeout(200)
  }
  return false
}

/** 浮条是否在（输入框上方的「正在朗读」条） */
async function speakBarText(page) {
  return await page.evaluate(() => {
    const el = document.querySelector('.speak-bar')
    return el ? el.innerText.replace(/\n/g, ' ').trim() : ''
  })
}

/** 停掉当前朗读，回到无声状态（避免测试之间串音） */
async function stopAllSpeech(page) {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.speak-bar-btn')).find((b) => (b.textContent || '').includes('停止'))
    if (btn) btn.click()
  })
  await page.waitForTimeout(500)
}

/** 列出全部会话 id（含归档，用于"新增了哪些"的差集） */
async function listSessionIds(page) {
  const res = await page.request.get(`${API}/api/sessions?archived=all`)
  const arr = await res.json()
  return Array.isArray(arr) ? arr.map((s) => s.id) : []
}

/**
 * 新建一个空会话，让本轮验收的测试消息**只落在这个一次性会话里**。
 *
 * ⚠️ 必须做：脚本会在真实的聊天页里真发消息，而 `doSend` 写入的是**当前会话**。
 * 第一版没做这一步，12 条 "自动朗读验收 X" 直接写进了老板的真实会话
 * （实测 2 次运行共 24 条），事后要靠 SQL 精确回滚 —— 验收脚本污染用户数据是不可接受的。
 */
async function startFreshSession(page) {
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, .nav-item, a')).find((b) => (b.textContent || '').trim() === '新建任务')
    if (btn) btn.click()
  })
  await page.waitForTimeout(900)
}

/** 删掉本次验收新建的会话（只删"运行前后差集"，且断言恰好 1 个） */
async function cleanupSession(page, beforeIds) {
  const after = await listSessionIds(page)
  const created = after.filter((id) => !beforeIds.includes(id))
  if (created.length !== 1) {
    console.log(`  [cleanup] 新增会话 ${created.length} 个（预期 1）→ 不动任何数据，请人工确认: ${created.join(', ')}`)
    return { ok: false, created }
  }
  const res = await page.request.delete(`${API}/api/sessions/${created[0]}`)
  const left = await listSessionIds(page)
  return { ok: res.ok() && !left.includes(created[0]), created }
}

/** 振荡器计数（证明"提示音响没响"） */
async function oscCount(page) {
  return await page.evaluate(() => (window.__scSound ? window.__scSound.oscs.length : -1))
}
async function resetAudio(page) {
  await page.evaluate(() => {
    if (window.__scSound) { window.__scSound.oscs = []; window.__scSound.gains = []; window.__scSound.calls = [] }
  })
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'zh-CN' })
const page = await ctx.newPage()

const pageErrors = []
const consoleErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

// —— 音频探针：代理 AudioContext 数振荡器（判断完成提示音响没响）——
await page.addInitScript(() => {
  const Orig = window.AudioContext || window.webkitAudioContext
  window.__scSound = { oscs: [], gains: [], calls: [] }
  try {
    window.AudioContext = class extends Orig {
      createOscillator() { const o = super.createOscillator(); window.__scSound.oscs.push(o); return o }
      createGain() { const g = super.createGain(); window.__scSound.gains.push(g); return g }
    }
    window.webkitAudioContext = window.AudioContext
  } catch { /* noop */ }
})

// —— 前台/后台探针：可控开关 + 保留真实读数（证明"前台"不是被覆盖值骗出来的）——
await page.addInitScript(() => {
  window.__scFg = true
  const realHasFocus = Document.prototype.hasFocus
  window.__scRealHasFocus = () => realHasFocus.call(document)
  try {
    Object.defineProperty(Document.prototype, 'visibilityState', {
      configurable: true,
      get() { return window.__scFg ? 'visible' : 'hidden' },
    })
  } catch { /* noop */ }
  Document.prototype.hasFocus = function () { return window.__scFg ? true : false }
})

const ttsPosts = recordTtsPosts(page)

try {
  // ===== 0. 基线 =====
  console.log('\n[0] 基线与设置页')
  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1800)
  const baseline = await getSettings(page)
  console.log(`  基线：autoReadMode=${baseline.autoReadMode} sound=${baseline.completionSound} tone=${baseline.completionSoundTone}`)
  const restore = {
    autoReadMode: baseline.autoReadMode || 'background',
    completionSound: baseline.completionSound !== false,
    completionSoundTone: baseline.completionSoundTone || 'classic',
    completionSoundVolume: Number(baseline.completionSoundVolume ?? 0.15),
  }
  check('页面无 pageerror', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
  await dismissModals(page)

  // 真实前台读数（在被 __scFg 覆盖之前拿到的原函数）
  const realFg = await page.evaluate(() => window.__scRealHasFocus())
  check('真机前台读数 = 前台（说明"后台"断言不是被覆盖值骗出来的）', realFg === true, `realHasFocus=${realFg}`)

  // 验收会真发消息 → 结束时用"会话差集"精确删掉本次新建的那一个（绝不碰老板的真实会话）
  const sessionsBefore = await listSessionIds(page)
  console.log(`  会话基线：${sessionsBefore.length} 个（结束时将删除本次新建的那 1 个）`)

  // ===== 1. 设置页：自动朗读三档 =====
  console.log('\n[1] 设置页「自动朗读」三档')
  const switched = await page.evaluate(() => {
    const t = Array.from(document.querySelectorAll('.n-tabs-tab')).find((e) => (e.textContent || '').includes('语音与声音'))
    if (!t) return false
    t.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return true
  })
  check('切到「语音与声音」tab', switched)
  await page.waitForTimeout(600)
  const paneText = await visiblePaneText(page)
  check('「自动朗读」行已渲染（i18n 实渲染）', paneText.includes('自动朗读'), paneText.replace(/\n/g, ' / ').slice(0, 170))

  const opened = await openSelect(page, '自动朗读')
  check('打开自动朗读下拉', opened)
  await page.waitForTimeout(600)
  const opts = await visibleOptionTexts(page)
  check('下拉含 3 档', opts.length === 3, JSON.stringify(opts))
  check('档位名称已本地化', ['关闭（仅手动）', '仅窗口不在前台时', '回复完成即朗读'].every((t) => opts.includes(t)), JSON.stringify(opts))

  const picked = await clickOptionName(page, '回复完成即朗读')
  check('选择「回复完成即朗读」', picked)
  await page.waitForTimeout(1400)
  const afterPick = await getSettings(page)
  check('档位已落库', afterPick.autoReadMode === 'always', `server=${afterPick.autoReadMode}`)
  check('下拉回显 = 所选档位', (await selectedLabel(page, '自动朗读')).includes('回复完成即朗读'))

  // ===== 2. always + 前台 → 必须自动朗读 =====
  console.log('\n[2] always + 前台 → 自动朗读')
  // 新建一次性会话：本轮所有测试消息只落在这里，结束时整会话删除（不碰老板的真实会话）
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1200)
  await dismissModals(page)
  await startFreshSession(page)
  ttsPosts.length = 0
  await resetAudio(page)
  await stubAgentStream(page, { text: '这是本轮答案，应该被念出来。' })
  await page.evaluate(() => { window.__scFg = true })
  await sendRound(page, '自动朗读验收 A')
  const idleA = await waitIdle(page)
  check('本轮已结束', idleA)
  await page.waitForTimeout(2200) // 等 TTS 合成 + 起播
  check('always + 前台：真的请求了 TTS（开始朗读）', ttsPosts.length > 0, `posts=${ttsPosts.length}`)
  check('朗读文本 = 本轮答案（不是别的内容）', (ttsPosts[0]?.text || '').includes('这是本轮答案'), JSON.stringify(ttsPosts[0] || {}).slice(0, 120))
  const barA = await speakBarText(page)
  check('「正在朗读」浮条出现', barA.includes('正在朗读'), JSON.stringify(barA))
  check('浮条带「停止」入口', barA.includes('停止'), JSON.stringify(barA))
  await stopAllSpeech(page)
  check('点停止后浮条消失', (await speakBarText(page)) === '')

  // ===== 3. background + 前台 → 绝不能自动朗读 =====
  console.log('\n[3] background + 前台 → 不朗读')
  check('档位切到「仅窗口不在前台时」', await setAutoReadMode(page, '仅窗口不在前台时'))
  await page.evaluate(() => { window.__scFg = true })
  ttsPosts.length = 0
  await sendRound(page, '自动朗读验收 B')
  const idleB = await waitIdle(page)
  check('本轮已结束', idleB)
  await page.waitForTimeout(2000)
  check('background + 前台：没有发起任何朗读请求（不打扰看屏幕的人）', ttsPosts.length === 0, `posts=${ttsPosts.length}`)
  check('浮条未出现', (await speakBarText(page)) === '')

  // ===== 4. background + 后台 → 必须自动朗读（老板选的主场景）=====
  console.log('\n[4] background + 后台 → 自动朗读')
  await page.evaluate(() => { window.__scFg = false })
  ttsPosts.length = 0
  await sendRound(page, '自动朗读验收 C')
  const idleC = await waitIdle(page)
  check('本轮已结束', idleC)
  await page.waitForTimeout(2200)
  check('background + 后台：发起朗读请求', ttsPosts.length > 0, `posts=${ttsPosts.length}`)
  await stopAllSpeech(page)

  // ===== 5. off + 后台 → 不朗读 =====
  console.log('\n[5] off + 后台 → 不朗读')
  check('档位切到「关闭（仅手动）」', await setAutoReadMode(page, '关闭（仅手动）'))
  await page.evaluate(() => { window.__scFg = false })
  ttsPosts.length = 0
  await sendRound(page, '自动朗读验收 D')
  const idleD = await waitIdle(page)
  check('本轮已结束', idleD)
  await page.waitForTimeout(2000)
  check('off：后台也不朗读', ttsPosts.length === 0, `posts=${ttsPosts.length}`)

  // ===== 6. 断流（无 done）→ 既不响提示音、也不朗读（本轮顺带修的 bug）=====
  console.log('\n[6] 断流（无 done）→ 不出声')
  check('档位切回「回复完成即朗读」', await setAutoReadMode(page, '回复完成即朗读'))
  // 提示音开关必须先打开，否则下面"没响"是恒真断言（关了当然不响）—— 这类假通过最危险
  await postSettings(page, { completionSound: true })
  await page.waitForTimeout(400)
  check('前置：完成提示音开关确认为开（否则"没响"是恒真断言）', (await getSettings(page)).completionSound !== false)
  await page.evaluate(() => { window.__scFg = false })
  await stubAgentStream(page, { text: '这段是断流任务的半截内容，不该被念出来。', withDone: false })
  ttsPosts.length = 0
  await resetAudio(page)
  await sendRound(page, '自动朗读验收 E')
  const idleE = await waitIdle(page, 25000) // 有一次 800ms 重试
  check('本轮已结束（含重试）', idleE)
  await page.waitForTimeout(2200)
  check('断流：不朗读（失败轮次一律不出声）', ttsPosts.length === 0, `posts=${ttsPosts.length}`)
  const oscE = await oscCount(page)
  check('断流：完成提示音也不响（修掉"中断也叮一声"）', oscE === 0, `osc=${oscE}`)

  // ===== 7. 对照：同样的 always + 后台，但正常结束 → 提示音与朗读都出声 =====
  console.log('\n[7] 对照：正常结束 → 提示音 + 朗读都在')
  await stubAgentStream(page, { text: '这段是正常结束的答案。' })
  ttsPosts.length = 0
  await resetAudio(page)
  await sendRound(page, '自动朗读验收 F')
  const idleF = await waitIdle(page)
  check('本轮已结束', idleF)
  await page.waitForTimeout(2200)
  const oscF = await oscCount(page)
  check('正常结束：完成提示音响了（与断流形成对照）', oscF > 0, `osc=${oscF}`)
  check('正常结束：朗读也发起了（老板拍板两者都保留）', ttsPosts.length > 0, `posts=${ttsPosts.length}`)
  await stopAllSpeech(page)

  // ===== 8. 手动点朗读 → 浮条出现（同一条路径，不区分自动/手动）=====
  console.log('\n[8] 手动朗读也走同一浮条')
  ttsPosts.length = 0
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.message-actions button')).find((b) => (b.getAttribute('title') || '').includes('朗读'))
    if (!btn) return false
    btn.click()
    return true
  })
  check('点到最后一条消息的「朗读」按钮', clicked)
  await page.waitForTimeout(2200)
  const barH = await speakBarText(page)
  check('手动朗读时浮条同样出现', barH.includes('正在朗读'), JSON.stringify(barH))
  await stopAllSpeech(page)
  check('停止后浮条消失', (await speakBarText(page)) === '')

  // ===== 9. 运行期异常 =====
  console.log('\n[9] 运行期异常')
  const realErrors = consoleErrors.filter((e) => !/favicon|404|Failed to load resource/i.test(e))
  check('运行期无页面级异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
  check('运行期无控制台错误', realErrors.length === 0, realErrors.join(' | ').slice(0, 200))

  // ===== 10. 复原设置 + 清理一次性会话 =====
  console.log('\n[10] 复原设置与清理')
  await postSettings(page, restore)
  const finalState = await getSettings(page)
  check('自动朗读档位回到进入时的快照', finalState.autoReadMode === restore.autoReadMode, `server=${finalState.autoReadMode}`)

  await page.screenshot({ path: '/tmp/sc-auto-read.png' })

  const cleanup = await cleanupSession(page, sessionsBefore)
  check('验收新建的一次性会话已删除（不污染真实会话）', cleanup.ok, `created=${cleanup.created.join(',') || '(无)'}`)
  const sessionsAfter = await listSessionIds(page)
  check('会话总数回到基线', sessionsAfter.length === sessionsBefore.length, `${sessionsBefore.length} → ${sessionsAfter.length}`)
} catch (e) {
  fail++
  failures.push('脚本异常: ' + e.message)
  console.log('\n脚本异常: ' + e.stack)
} finally {
  await browser.close()
}

console.log(`\n===== 自动朗读验收：${pass} passed / ${fail} failed =====`)
if (failures.length) console.log('失败项: ' + failures.join(', '))
process.exit(fail === 0 ? 0 : 1)
