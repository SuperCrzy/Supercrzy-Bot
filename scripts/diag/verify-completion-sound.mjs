/**
 * 设置页「语音与声音」真机验收 (2026-09-27)
 *
 * 覆盖两轮改动：
 *  A. 完成提示音可选：4 款内置音效 + 音量滑杆（[0]~[9]）
 *  B. 下拉内嵌试听：朗读音色/提示音音色每项右侧一个喇叭按钮，点喇叭只试听、点名字才确认选择，
 *     选中即自动试听（[10]~[12]）
 *
 * 验的是什么：**老板在设置页点一下，聊天里响的/读的就是他听到的那个。**
 *
 * 为什么不能只跑单测：单测证明的是 `playCompletionTone()` / `preview()` 按参数工作；
 * 证明不了「下拉选项 → form → appStore → 聊天调用点 → WebAudio/Edge TTS」这条**跨模块链路**通。
 * 本脚本用两个独立通道观测同一件事：
 *   · 界面通道：下拉选中值 / 音量回显 / 选项内图标（play ⇄ stop）
 *   · 媒体通道：注入 AudioContext 代理读**真实振荡器**的频率/波形/增益；拦截 /api/tts 读**真实请求体**
 * 判决性断言各一条（防"看起来通过了"）：
 *   · 点晓伊的喇叭 → 请求体里 voice=晓伊 **且台词里提到晓伊**（否则"所有喇叭都播晓晓"也会全绿）
 *   · 点喇叭后**选中值不许变**（验证 stopPropagation 真的拦住了 naive 的选中逻辑）
 * 另加只在此层可测的点：关掉开关时音色/音量两行必须收起（v-if）、改动必须防抖落库（GET 复核）、
 * 刷新后回显一致、行内独立「试听」按钮已移除（搬进下拉）。
 *
 * 用法（干净 env，见技能 clean-shell-env）：
 *   node scripts/diag/verify-completion-sound.mjs
 * 环境变量：SC_BASE（默认 http://localhost:5173）、SC_API（默认 http://localhost:3000）
 * 退出码：0 = 全过；1 = 有 FAIL。
 *
 * 注意：脚本会临时改动本机设置（音色/音量/提示音音色/朗读音色），结束时按进入时的快照**原样恢复**。
 * 若老板自己正开着设置页，并发写入会让"服务端值 = 我选的值"类断言偶发不符。
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

/** 在页面里按可见文本点击（dispatchEvent，绕开 naive-ui 覆盖层的 hit-test 干扰） */
async function clickText(page, selector, text) {
  return await page.evaluate(({ selector, text }) => {
    const els = Array.from(document.querySelectorAll(selector))
    const hit = els.find((el) => (el.textContent || '').trim() === text)
      || els.find((el) => (el.textContent || '').includes(text))
    if (!hit) return false
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }, { selector, text })
}

/**
 * 关掉自动弹出的弹窗。
 *
 * ⚠️ 必须做，且必须用**真实鼠标**才会发现这件事：设置页挂载 600ms 后，
 * UpdatePanel 会因为「已读版本 ≠ 当前版本」自动弹出更新日志 modal（新 profile 必弹）。
 * naive-ui 的 `.n-modal-mask` 覆盖整屏 → **真实鼠标事件全被吃掉**，
 * 而 dispatchEvent 派发的事件不受 hit-test 影响 ⇒ 出来的现象极具欺骗性：
 * 「下拉能选、试听能响，但点滑杆没反应」，很容易误判成滑杆坏了。
 */
async function dismissModals(page) {
  await page.waitForTimeout(900)
  const has = async () => await page.locator('.n-modal-mask').count() > 0
  if (!(await has())) return false
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  if (!(await has())) return true
  // 兜底：点遮罩空白处（naive 默认 maskClosable）
  await page.mouse.click(12, 400)
  await page.waitForTimeout(400)
  return !(await has())
}

/** 读当前**可见**tab 面板的文本（不可见面板 innerText 恒为 '' —— 曾因此误报 3 项失败） */
async function visiblePaneText(page) {
  return await page.evaluate(() => {
    const panes = Array.from(document.querySelectorAll('.n-tab-pane'))
    const vis = panes.find((p) => p.getClientRects().length > 0)
    return vis ? vis.innerText : ''
  })
}

/** 读当前页面里记录到的音频调度（频率/波形/增益/起始时间） */
async function audioSnapshot(page) {
  return await page.evaluate(() => {
    const s = window.__scSound
    if (!s) return { err: 'instrumentation missing' }
    const pick = (param, kind) => {
      const c = s.calls.find((c) => c.param === param && c.kind === kind)
      return c ? c.value : null
    }
    return {
      err: s.err,
      oscCount: s.oscs.length,
      freqs: s.oscs.map((o) => pick(o.frequency, 'set')),
      types: s.oscs.map((o) => o.type),
      gains: s.oscs.map((o, i) => (s.gains[i] ? pick(s.gains[i].gain, 'set') : null)),
      ramps: s.oscs.map((o, i) => (s.gains[i] ? pick(s.gains[i].gain, 'ramp') : null)),
      starts: s.oscs.map((o) => {
        const c = s.calls.find((c) => c.param === o.frequency && c.kind === 'set')
        return c ? c.time : null
      }),
    }
  })
}

async function resetInstrumentation(page) {
  await page.evaluate(() => { window.__scSound.oscs = []; window.__scSound.gains = []; window.__scSound.calls = [] })
}

async function getSettings(page) {
  const res = await page.request.get(`${API}/api/settings`)
  return await res.json()
}
async function postSettings(page, body) {
  const res = await page.request.post(`${API}/api/settings`, { data: body })
  return res.status()
}

// ===== 下拉交互助手（2026-09-27：试听按钮搬进下拉后，多处步骤都要驱动下拉，统一在这里定义）=====

/** 收集发往 /api/tts 的 POST body（用来断言"试听请求带的 voice/台词对不对"） */
function recordTtsPosts(page) {
  const posts = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/tts')) {
      try { posts.push(JSON.parse(req.postData() || '{}')) } catch { posts.push({}) }
    }
  })
  return posts
}

/** 打开某设置行里的下拉（dispatchEvent：绕开遮罩 hit-test，naive 仍按真实点击处理） */
async function openSelect(page, rowLabel) {
  return await page.evaluate((label) => {
    const row = Array.from(document.querySelectorAll('.setting-row')).find((r) => (r.textContent || '').includes(label))
    const sel = row?.querySelector('.n-base-selection')
    if (!sel) return false
    sel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }, rowLabel)
}

/** 读某行下拉框里显示的**当前选中值**（判断"点喇叭是否误改了选择"） */
async function selectedLabel(page, rowLabel) {
  return await page.evaluate((label) => {
    const row = Array.from(document.querySelectorAll('.setting-row')).find((r) => (r.textContent || '').includes(label))
    return row?.querySelector('.n-base-selection-label')?.textContent?.trim() || ''
  }, rowLabel)
}

/** 点某个选项的**名字**（= 确认选择）。只在当前可见的下拉里找，避免点到别的下拉的选项 */
async function clickOptionName(page, optionText) {
  return await page.evaluate((text) => {
    const menu = Array.from(document.querySelectorAll('.n-base-select-menu')).find((m) => m.getClientRects().length > 0)
    const opt = Array.from(menu?.querySelectorAll('.n-base-select-option') || []).find((o) => (o.textContent || '').includes(text))
    if (!opt) return false
    opt.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }, optionText)
}

/** 当前可见下拉里的选项文本列表（i18n 渲染核对用） */
async function visibleOptionTexts(page) {
  return await page.evaluate(() => {
    const menu = Array.from(document.querySelectorAll('.n-base-select-menu')).find((m) => m.getClientRects().length > 0)
    return Array.from(menu?.querySelectorAll('.n-base-select-option') || []).map((o) => (o.textContent || '').trim())
  })
}

/** 选项统计：当前**可见**下拉里 选项总数 + 内嵌播放按钮数
 *
 * ⚠️ 两个坑（都踩过）：
 *  1. naive-ui 的 `render-option` 是**包裹**不是替换 —— 播放按钮是 `.n-base-select-option` 的
 *     **兄弟**节点（外层是我们自己的 `.sc-sound-opt`），`option.querySelector('.n-button')` 永远为空。
 *  2. 各个下拉的菜单节点会同时留在 DOM（隐藏的那个也算），不限定"可见菜单"会把两三个下拉的
 *     选项数加在一起（实测 6+4=10），让断言看着莫名其妙。
 */
async function optionStats(page) {
  return await page.evaluate(() => {
    const menu = Array.from(document.querySelectorAll('.n-base-select-menu')).find((m) => m.getClientRects().length > 0)
    const rows = Array.from(menu?.querySelectorAll('.sc-sound-opt') || [])
    return { opts: rows.length, btns: rows.filter((r) => r.querySelector('.n-button')).length }
  })
}

/** 点某个选项内嵌的播放按钮（stopPropagation 是否真的拦住"选中"，靠点击后的选中值验证） */
async function clickOptionPlay(page, optionText) {
  return await page.evaluate((text) => {
    const menu = Array.from(document.querySelectorAll('.n-base-select-menu')).find((m) => m.getClientRects().length > 0)
    const row = Array.from(menu?.querySelectorAll('.sc-sound-opt') || []).find((r) => (r.textContent || '').includes(text))
    if (!row) return { ok: false, reason: 'option-not-found' }
    const btn = row.querySelector('.n-button')
    if (!btn) return { ok: false, reason: 'no-play-button' }
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return { ok: true }
  }, optionText)
}

/** 等某选项按钮的图标变成期望状态（有界轮询）
 *
 * 为什么不能 sleep 固定时长：试听要先 fetch 合成（~0.6s）再播完台词（~2.5s），
 * 总时长随文案/网络变化。写死 2.6s 会随机红（实测就是这样失败的）。 */
async function waitForGlyph(page, optionText, want, timeoutMs = 10000) {
  const t0 = Date.now()
  let last = 'none'
  while (Date.now() - t0 < timeoutMs) {
    last = await optionGlyph(page, optionText)
    if (last === want) return { ok: true, ms: Date.now() - t0 }
    await page.waitForTimeout(250)
  }
  return { ok: false, ms: Date.now() - t0, last }
}

/** 读某选项按钮上的图标类型（play=三角 / stop=方块）——用来验证"播放中切成停止" */
async function optionGlyph(page, optionText) {
  return await page.evaluate((text) => {
    const menu = Array.from(document.querySelectorAll('.n-base-select-menu')).find((m) => m.getClientRects().length > 0)
    const row = Array.from(menu?.querySelectorAll('.sc-sound-opt') || []).find((r) => (r.textContent || '').includes(text))
    const svg = row?.querySelector('.n-button svg')
    if (!svg) return 'none'
    if (svg.querySelector('rect')) return 'stop'
    if (svg.querySelector('path')) return 'play'
    return 'other'
  }, optionText)
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'zh-CN' })
const page = await ctx.newPage()

const pageErrors = []
const consoleErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })

// —— 音频探针：代理 AudioContext + 补 AudioParam 调度记录（两个独立通道之一）——
await page.addInitScript(() => {
  const Orig = window.AudioContext || window.webkitAudioContext
  window.__scSound = { oscs: [], gains: [], calls: [], err: null }
  try {
    // 用一个临时 ctx 拿到 AudioParam 原型，给所有参数调度打点（不改 sound.ts 一行代码）
    const probe = new Orig()
    const proto = Object.getPrototypeOf(probe.createGain().gain)
    const origSet = proto.setValueAtTime
    const origRamp = proto.exponentialRampToValueAtTime
    proto.setValueAtTime = function (v, t) { window.__scSound.calls.push({ param: this, value: v, time: t, kind: 'set' }); return origSet.call(this, v, t) }
    proto.exponentialRampToValueAtTime = function (v, t) { window.__scSound.calls.push({ param: this, value: v, time: t, kind: 'ramp' }); return origRamp.call(this, v, t) }
    try { probe.close() } catch { /* noop */ }
  } catch (e) { window.__scSound.err = 'param-patch: ' + e.message }
  window.AudioContext = class extends Orig {
    createOscillator() { const o = super.createOscillator(); window.__scSound.oscs.push(o); return o }
    createGain() { const g = super.createGain(); window.__scSound.gains.push(g); return g }
  }
  window.webkitAudioContext = window.AudioContext
})

try {
  // ===== 0. 进入设置页，页面必须无异常（TDZ 陷阱：类型检查全绿也会白屏）=====
  console.log('\n[0] 进入设置页')
  await page.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1800)
  const baseline = await getSettings(page)
  console.log(`  基线：tone=${baseline.completionSoundTone} vol=${baseline.completionSoundVolume} sound=${baseline.completionSound}`)
  check('页面无 pageerror', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
  check('设置页已渲染（能找到标签页）', await page.locator('.n-tabs-tab').count() > 0)
  const modalClosed = await dismissModals(page)
  check('自动弹出的更新日志弹窗可关闭（否则遮罩会吃掉所有真实鼠标操作）', modalClosed, modalClosed ? '' : '弹窗仍在，后续真实点击无效')

  // ===== 1. 切到「语音与声音」tab =====
  console.log('\n[1] 语音与声音 tab')
  const switched = await clickText(page, '.n-tabs-tab', '语音与声音')
  check('找到并点击「语音与声音」', switched)
  await page.waitForTimeout(500)
  const tabText = await visiblePaneText(page)
  check('提示音音色行已渲染（i18n 实渲染）', tabText.includes('提示音音色'), tabText.replace(/\n/g, ' / ').slice(0, 160))
  check('提示音音量行已渲染', tabText.includes('提示音音量'))
  check('朗读音色行已渲染', tabText.includes('朗读音色'))

  // 确保提示音是开的（否则音色行被 v-if 收起，后面的选择/试听跑不到）
  const soundOn0 = baseline.completionSound !== false
  if (!soundOn0) {
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.setting-row')).find((r) => (r.textContent || '').includes('完成提示音'))
      row?.querySelector('.n-switch')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForTimeout(700)
  }
  // ⚠️ 别写死数量：2026-09-28 加「自动朗读」下拉后这里变成 3，写死 2 会假失败。
  // 改成列出"哪些行带下拉"，数量变化时看输出就知道是谁进来了。
  const selectRows = await page.evaluate(() => {
    const pane = Array.from(document.querySelectorAll('.n-tab-pane')).find((p) => p.getClientRects().length > 0)
    if (!pane) return []
    return Array.from(pane.querySelectorAll('.setting-row'))
      .filter((r) => r.querySelector('.n-select'))
      .map((r) => (r.querySelector('.setting-label')?.textContent || '').trim())
  })
  check('三个下拉（提示音音色 / 朗读音色 / 自动朗读）均已渲染',
    selectRows.length === 3, JSON.stringify(selectRows))

  // ===== 2. 音色下拉：4 个内置音效，含中文名 =====
  console.log('\n[2] 音色下拉')
  const opened = await openSelect(page, '提示音音色')
  check('打开音色下拉', opened)
  await page.waitForTimeout(600)
  const optionTexts = await visibleOptionTexts(page)
  check('下拉含 4 款音效', optionTexts.length === 4, JSON.stringify(optionTexts))
  check('音效名称已本地化', ['经典双音', '单音轻响', '柔和琶音', '下降双音'].every((t) => optionTexts.includes(t)), JSON.stringify(optionTexts))

  // ===== 3. 选「柔和琶音」（chord）=====
  console.log('\n[3] 选 柔和琶音')
  const picked = await clickOptionName(page, '柔和琶音')
  check('选中 柔和琶音', picked)
  await page.waitForTimeout(1400) // 等防抖自动保存（600ms）
  const afterTone = await getSettings(page)
  check('音色已落库 completionSoundTone=chord', afterTone.completionSoundTone === 'chord', `got=${JSON.stringify(afterTone.completionSoundTone)}`)

  // ===== 4. 音量：真实鼠标点击轨道（位置 → 值映射）+ 回显 + 落库 =====
  // 注意两点，都是踩过的坑：
  //   · naive-ui 的 `.n-slider-handle` 没有 tabindex → 组件不支持键盘操作，别写方向键断言；
  //   · `dispatchEvent(mousedown)` 的 clientX 恒为 0 → 会把滑杆钉在最小值并留下卡住的拖拽态，
  //     之后的真实点击全部失效 ⇒ 音量必须用真实鼠标事件驱动。
  console.log('\n[4] 音量滑杆（真实鼠标输入）')
  const readVol = async () => await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.setting-row')).find((r) => (r.textContent || '').includes('提示音音量'))
    return row?.querySelector('.setting-range-val')?.textContent?.trim()
  })
  const railBox = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.setting-row')).find((r) => (r.textContent || '').includes('提示音音量'))
    const rail = row?.querySelector('.n-slider-rail')
    if (!rail) return null
    const r = rail.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  })
  check('取到音量轨道矩形', !!railBox && railBox.w > 0, railBox ? `w=${railBox.w}` : '')
  const volBefore = await readVol()
  console.log(`  起始回显：${volBefore}`)
  const MIN = 0.05, MAX = 0.4, STEP = 0.05
  const onGrid = (v) => typeof v === 'number' && Math.abs(Math.round((v - MIN) / STEP) * STEP + MIN - v) < 1e-9
  const clickRail = async (ratio) => {
    // 注意：ratio=1（x = 轨道右边界）会落到轨道**之外**的元素上，滑杆收不到 mousedown
    // ⇒ 值不变（看着像"没夹到上界"）。要最大值得点在轨道内 —— 用 w-1。
    const px = ratio >= 1 ? railBox.w - 1 : railBox.w * ratio
    await page.mouse.click(railBox.x + px, railBox.y + railBox.h / 2)
    await page.waitForTimeout(1500)
    return { ui: await readVol(), server: (await getSettings(page)).completionSoundVolume }
  }
  if (railBox) {
    // 断言的是「位置→值」的不变量（单调/端点夹取/步进网格/回显一致/可重复），
    // 不去反推 naive-ui 内部公式（它做了 handleSize 修正：(offset-h/2)/(w-h)，反推出来的
    // 期望值会随组件实现细节变化 —— 那是测试组件，不是测试我们的功能）。
    const left = await clickRail(0)
    check('轨道最左 → 夹到下界 0.05（不会被拖出范围）', Math.abs(left.server - MIN) < 1e-9, `got=${left.server}`)

    const right = await clickRail(1)
    check('轨道最右 → 夹到上界 0.4', Math.abs(right.server - MAX) < 1e-9, `got=${right.server}`)

    const q1 = await clickRail(0.25)
    const q2 = await clickRail(0.75)
    check('位置单调：75% 处 > 25% 处（不是"点哪都一个值"）', q2.server > q1.server, `25%→${q1.server} 75%→${q2.server}`)
    check('全部落点都在 0.05 步进网格上', [left, right, q1, q2].every((r) => onGrid(r.server)), JSON.stringify([left.server, right.server, q1.server, q2.server]))

    const q1b = await clickRail(0.25)
    check('同位置点击可重复（值稳定，不漂移）', Math.abs(q1b.server - q1.server) < 1e-9, `${q1.server} vs ${q1b.server}`)

    const mid = await clickRail(0.5)
    check('中点值落在 0.225 附近（±1 档）', Math.abs(mid.server - 0.225) <= STEP + 1e-9, `got=${mid.server}`)

    check('每一步回显都 = 服务端值（UI 与落库不分叉）',
      [left, right, q1, q2, q1b, mid].every((r) => `${Math.round(r.server * 100)}%` === r.ui),
      JSON.stringify({ left: left.ui, right: right.ui, q1: q1.ui, q2: q2.ui, q1b: q1b.ui, mid: mid.ui }))
  }

  // ===== 5. 试听：真实振荡器频率/波形/增益必须匹配「柔和琶音」=====
  // 试听入口已从"行内独立按钮"搬进下拉（点该行右侧喇叭），所以这里要先把下拉打开。
  console.log('\n[5] 试听（真实 WebAudio 图）')
  await openSelect(page, '提示音音色')
  await page.waitForTimeout(500)
  await resetInstrumentation(page)
  const previewClicked = await clickOptionPlay(page, '柔和琶音')
  check('点下拉内柔和琶音的喇叭', previewClicked.ok, JSON.stringify(previewClicked))
  await page.waitForTimeout(500)
  const snap = await audioSnapshot(page)
  // 音量在上一步可能刚被改过，取最新值做基准
  const expectGain = (await getSettings(page)).completionSoundVolume
  check('探针就绪（不是探针自身失败）', !snap.err, String(snap.err))
  check('chord 试听产生 3 个音', snap.oscCount === 3, `oscCount=${snap.oscCount}`)
  check('频率序列 = 523/659/784（升序琶音）', JSON.stringify(snap.freqs) === JSON.stringify([523, 659, 784]), JSON.stringify(snap.freqs))
  check('波形 = triangle（音效表原样下发）', snap.types.every((t) => t === 'triangle'), JSON.stringify(snap.types))
  check('增益 = 当前设置的音量值', snap.gains.every((g) => Math.abs(g - expectGain) < 1e-6), `gains=${JSON.stringify(snap.gains)} expect=${expectGain}`)
  check('每个音都以指数衰减收尾（ramp → 0.001）', snap.ramps.every((r) => Math.abs(r - 0.001) < 1e-9), JSON.stringify(snap.ramps))
  check('音序按 0/0.07/0.14 秒错开（不是同时响）',
    snap.starts.every((s, i) => i === 0 || s > snap.starts[i - 1]), JSON.stringify(snap.starts))

  // ===== 6. 另选「经典双音」试听：必须是老声音（2 音 / C5+E5 / sine）=====
  console.log('\n[6] 试听 经典双音（老默认音未被改）')
  await page.waitForTimeout(600) // 等上一条音效衰减完，避免混音
  await resetInstrumentation(page)
  await clickOptionPlay(page, '经典双音')
  await page.waitForTimeout(500)
  const snap2 = await audioSnapshot(page)
  check('classic 试听产生 2 个音', snap2.oscCount === 2, `oscCount=${snap2.oscCount}`)
  check('频率 = 523/659 且波形 sine（老默认音未被改）',
    JSON.stringify(snap2.freqs) === JSON.stringify([523, 659]) && snap2.types.every((t) => t === 'sine'),
    `${JSON.stringify(snap2.freqs)} / ${JSON.stringify(snap2.types)}`)

  // ===== 7. 关掉开关 → 音色/音量两行收起；打开 → 回来 =====
  console.log('\n[7] 开关联动（v-if）')
  await page.keyboard.press('Escape') // 先收起还开着的下拉
  await page.waitForTimeout(300)
  const toggle = async () => {
    await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('.setting-row')).find((r) => (r.textContent || '').includes('完成提示音'))
      row?.querySelector('.n-switch')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForTimeout(600)
  }
  const rowVisible = async () => await page.evaluate(() => {
    const txt = Array.from(document.querySelectorAll('.setting-row')).map((r) => (r.textContent || '')).join('|')
    return txt.includes('提示音音色')
  })
  await toggle()
  check('关闭后音色行收起', (await rowVisible()) === false)
  await toggle()
  check('重新打开后音色行回来', (await rowVisible()) === true)
  const afterToggle = await getSettings(page)
  check('开关状态已落库且与进入时一致', afterToggle.completionSound === (baseline.completionSound !== false), `now=${afterToggle.completionSound} base=${baseline.completionSound}`)

  // ===== 8. 恢复现场 + 闭环复核（服务端 → 界面）=====
  console.log('\n[8] 恢复设置并复核回显')
  const restore = {
    completionSoundTone: baseline.completionSoundTone || 'classic',
    completionSoundVolume: typeof baseline.completionSoundVolume === 'number' ? baseline.completionSoundVolume : 0.15,
    completionSound: baseline.completionSound !== false,
    ttsVoice: baseline.ttsVoice || 'zh-CN-XiaoxiaoNeural', // [10] 会改朗读音色，必须一起还原
  }
  await postSettings(page, restore)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1600)
  await dismissModals(page)
  await clickText(page, '.n-tabs-tab', '语音与声音')
  await page.waitForTimeout(500)
  const shownTone = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.setting-row')).find((r) => (r.textContent || '').includes('提示音音色'))
    return row?.querySelector('.n-base-selection')?.textContent?.trim()
  })
  const shownVol = await page.evaluate(() => {
    const row = Array.from(document.querySelectorAll('.setting-row')).find((r) => (r.textContent || '').includes('提示音音量'))
    return row?.querySelector('.setting-range-val')?.textContent?.trim()
  })
  const toneLabel = { classic: '经典双音', single: '单音轻响', chord: '柔和琶音', down: '下降双音' }[restore.completionSoundTone]
  check('刷新后音色回显 = 服务端值', shownTone === toneLabel, `ui=${shownTone} server=${restore.completionSoundTone}`)
  check('刷新后音量回显 = 服务端值', shownVol === `${Math.round(restore.completionSoundVolume * 100)}%`, `ui=${shownVol} server=${restore.completionSoundVolume}`)

  // ===== 10. 朗读音色：下拉每项内嵌播放按钮 + 选中即自动试听 =====
  // 本轮新增（老板："试听按钮直接做在下拉框里面…点击这个名字代表确认选择"）。
  // 判决性断言 = 试听请求的 body 里 **voice 与台词对得上**（晓伊的喇叭必须发晓伊的台词 ——
  // 只断言"发出了请求"会被"所有喇叭都播晓晓"骗过）。
  console.log('\n[10] 朗读音色下拉内嵌试听')
  const ttsPosts = recordTtsPosts(page)

  const voiceRowBefore = await selectedLabel(page, '朗读音色')
  await openSelect(page, '朗读音色')
  await page.waitForTimeout(600)
  const voiceOpts = await optionStats(page)
  check('音色下拉 6 项、每项都有内嵌播放按钮', voiceOpts.opts === 6 && voiceOpts.btns === 6, JSON.stringify(voiceOpts))

  ttsPosts.length = 0
  const playClicked = await clickOptionPlay(page, '晓伊')
  check('点到晓伊那行的播放按钮', playClicked.ok, JSON.stringify(playClicked))
  await page.waitForTimeout(900)
  const playPost = ttsPosts.find((p) => p.voice === 'zh-CN-XiaoyiNeural')
  check('点晓伊喇叭 → 请求 voice=晓伊', !!playPost, JSON.stringify(ttsPosts))
  check('试听台词是晓伊的自我介绍（不是所有喇叭都播晓晓）',
    !!playPost && String(playPost.text || '').includes('晓伊'), JSON.stringify(playPost?.text))
  check('台词含英文品牌名（中英混排）', !!playPost && String(playPost.text || '').includes('SUPERCRZY BOT'), String(playPost?.text))
  check('语速按当前设置下发（0 → default）', !!playPost && playPost.rate === 'default', String(playPost?.rate))
  check('点喇叭不改变选择（仍是原来的音色）', (await selectedLabel(page, '朗读音色')) === voiceRowBefore, `before=${voiceRowBefore} now=${await selectedLabel(page, '朗读音色')}`)
  check('播放中该行图标切成停止', (await waitForGlyph(page, '晓伊', 'stop', 5000)).ok, await optionGlyph(page, '晓伊'))
  const backToPlay = await waitForGlyph(page, '晓伊', 'play')
  check('播完图标自动回到播放', backToPlay.ok, JSON.stringify(backToPlay))

  // 点名字 = 确认选择 + 自动试听
  ttsPosts.length = 0
  const namePicked = await clickOptionName(page, '晓伊')
  check('点名字确认选择', namePicked)
  await page.waitForTimeout(1200)
  const voiceRowAfter = await selectedLabel(page, '朗读音色')
  check('选择已切换为晓伊', voiceRowAfter.includes('晓伊'), `ui=${voiceRowAfter}`)
  const afterPickPost = ttsPosts.find((p) => p.voice === 'zh-CN-XiaoyiNeural')
  check('选中即自动试听（无需再点按钮）', !!afterPickPost, JSON.stringify(ttsPosts))
  const voicePersisted = (await getSettings(page)).ttsVoice
  check('新音色已落库', voicePersisted === 'zh-CN-XiaoyiNeural', `server=${voicePersisted}`)

  // ===== 11. 提示音音色：下拉每项内嵌播放按钮 + 选中即响 =====
  console.log('\n[11] 提示音下拉内嵌试听')
  const toneRowBefore = await selectedLabel(page, '提示音音色')
  await openSelect(page, '提示音音色')
  await page.waitForTimeout(600)
  const toneOpts = await optionStats(page)
  check('提示音下拉 4 项、每项都有内嵌播放按钮', toneOpts.opts === 4 && toneOpts.btns === 4, JSON.stringify(toneOpts))
  const inlineTextBtn = await page.evaluate(() => {
    const pane = Array.from(document.querySelectorAll('.n-tab-pane')).find((p) => p.getClientRects().length > 0)
    return Array.from(pane?.querySelectorAll('.n-button') || []).filter((b) => (b.textContent || '').trim() === '试听').length
  })
  check('行内独立「试听」按钮已移除（移入下拉内）', inlineTextBtn === 0, `count=${inlineTextBtn}`)

  await page.waitForTimeout(300)
  await resetInstrumentation(page)
  const tonePlay = await clickOptionPlay(page, '柔和琶音')
  check('点到柔和琶音那行的播放按钮', tonePlay.ok, JSON.stringify(tonePlay))
  await page.waitForTimeout(500)
  const toneSnap = await audioSnapshot(page)
  check('点喇叭即响该音效（真实振荡器 3 音 523/659/784）',
    toneSnap.oscCount === 3 && JSON.stringify(toneSnap.freqs) === JSON.stringify([523, 659, 784]),
    `osc=${toneSnap.oscCount} freqs=${JSON.stringify(toneSnap.freqs)}`)
  check('点喇叭不改变选择', (await selectedLabel(page, '提示音音色')) === toneRowBefore, `before=${toneRowBefore} now=${await selectedLabel(page, '提示音音色')}`)

  await page.waitForTimeout(600)
  await resetInstrumentation(page)
  await clickOptionName(page, '下降双音')
  await page.waitForTimeout(900)
  const toneSnap2 = await audioSnapshot(page)
  check('点名字确认选择并自动响新音效（E5→C5 下降双音）',
    JSON.stringify(toneSnap2.freqs) === JSON.stringify([659, 523]), JSON.stringify(toneSnap2.freqs))
  const toneAfter = await selectedLabel(page, '提示音音色')
  check('提示音选择已切换为下降双音', toneAfter.includes('下降双音'), `ui=${toneAfter}`)
  const tonePersisted = (await getSettings(page)).completionSoundTone
  check('新提示音已落库', tonePersisted === 'down', `server=${tonePersisted}`)

  // ===== 12. 复原现场（10/11 又改了设置） =====
  console.log('\n[12] 复原设置')
  await postSettings(page, restore)
  const finalState = await getSettings(page)
  check('音色/音量/提示音音色均回到进入时的快照',
    finalState.ttsVoice === (baseline.ttsVoice || 'zh-CN-XiaoxiaoNeural')
    && Math.abs(Number(finalState.completionSoundVolume) - restore.completionSoundVolume) < 1e-9
    && finalState.completionSoundTone === restore.completionSoundTone,
    JSON.stringify({ tts: finalState.ttsVoice, vol: finalState.completionSoundVolume, tone: finalState.completionSoundTone }))

  // ===== 9. 全程无 console error =====
  console.log('\n[9] 运行期异常')
  const realErrors = consoleErrors.filter((e) => !/favicon|404|Failed to load resource/i.test(e))
  check('运行期无页面级异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200))
  check('运行期无控制台错误', realErrors.length === 0, realErrors.join(' | ').slice(0, 200))

  await page.screenshot({ path: '/tmp/sc-completion-sound.png' })
} catch (e) {
  fail++
  failures.push('脚本异常: ' + e.message)
  console.log('\n脚本异常: ' + e.stack)
} finally {
  await browser.close()
}

console.log(`\n===== 完成提示音验收：${pass} passed / ${fail} failed =====`)
if (failures.length) console.log('失败项: ' + failures.join(', '))
process.exit(fail === 0 ? 0 : 1)
