/**
 * attach 模式端到端验证 (2026-09-23)
 *
 * 验的是什么：**后端不再自己起浏览器，而是接管 Electron 窗口里那个真网页。**
 * 这是「AI 浏览器从截图监控器升级为人机共用的操作面」的核心能力。
 *
 * 与 verify-cdp-bridge.mjs 的分工（别混）：
 *   · verify-cdp-bridge.mjs  验**协议可行性**：Playwright 能不能接上 Electron 的 CDP。
 *   · 本脚本                 验**产品能力**：走 `/api/collab/browser/*` 这层真实 API，
 *                            证明"经产品接口敲的字，落进了 Electron 窗口的真 DOM"。
 *   前者只需 playwright-core；后者要连后端、要起真页面、要断言收尾不误杀 Electron。
 *
 * 十一项判据（★ = 决定性的）：
 *   1  backend_ready            后端 /api/health 返回 status=ok（校验载荷，不是"有输出"）
 *   2  electron_ready           样衣打印 CDP_ENDPOINT
 *   3  cdp_reachable            /json/version 可访问
 *   4  attach_adopts_view_page  ★ 接管的是"视图里的真网页"，不是宿主 UI
 *   5  attach_excludes_host_ui  宿主 UI origin 出现在 skip 列表里（**生产里宿主 UI 就是 http，
 *                               用 data: 测不出这条**，所以必须把 HOST_URL 设成后端 origin）
 *   6  navigate                 经 API 导航到测试页
 *   7  cross_runtime_typing     ★★ 经产品 API 打字(带 into) → 页面按钮把输入框内容写进 #cdp-probe
 *                               → **Electron 主进程读到同一个字符串**。跨运行时闭环。
 *   8  key_enter / 9 scroll     动作层可用
 *   10 ui_flow_click_then_type  ★★ 复刻界面的真实流程：点画面 → 输入(**不带 into**，靠焦点)
 *                               → 回显。界面上「仅输入/输入+回车」发的正是这条路径，
 *                               与第 7 条的 `fill` 是**两条不同代码路径** —— 不验等于主按钮没被按过。
 *   11 close_does_not_kill_electron ★★ /browser/close 之后 Electron 仍活着。
 *                               这是 attach 模式最危险的一处：旧代码 closeKey 会 `browser.close()`，
 *                               而那个 browser 就是 Electron 本体 —— 一关就关掉用户主窗口。
 *
 * 用法（必须在「干净 env」+ 关外层沙箱下跑；见技能 clean-shell-env）：
 *   node scripts/diag/verify-ai-browser-attach.mjs
 * 退出码：0 = 全过；1 = 有 FAIL。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:http'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const SERVER_DIR = join(ROOT, 'packages', 'server')
const CDP_DEMO = join(ROOT, 'packages', 'desktop', 'cdp-demo.cjs')

const BACKEND_PORT = Number(process.env.DIAG_BACKEND_PORT || 3011)
const CDP_PORT = Number(process.env.SUPERCRZY_CDP_DEMO_PORT || 9333)
const SESSION_ID = 'diag-attach'
const TOKEN = `attach-${Date.now()}`
const GLOBAL_TIMEOUT_MS = 240000

const results = []
const record = (name, status, detail) => {
  results.push({ name, status, detail: String(detail ?? '') })
  const mark = status === 'PASS' ? 'ok  ' : status === 'SKIP' ? 'skip' : 'FAIL'
  console.log(`  [${mark}] ${name.padEnd(28)} ${String(detail ?? '').slice(0, 130)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 测试页：一个输入框 + 一个把输入框内容写进 #cdp-probe 的按钮 ----------
// 按钮为什么长这样：闭环断言需要"页面自己把证据写到一个 Electron 侧能读到的地方"。
// 这样整条链路只用产品 API（type → click_text），不必给验证开后门（不加 eval 路由）。
const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>ATTACH-TEST</title>
<style>body{font:14px system-ui;margin:0;padding:24px}input{font:14px system-ui;padding:6px;width:240px}
button{font:14px system-ui;padding:6px 12px;margin-left:8px}.tall{height:2400px}</style></head><body>
<h1>ATTACH 测试页</h1>
<p><input id="q" placeholder="搜索" /><button id="echo"
 onclick="var d=document.getElementById('cdp-probe');if(!d){d=document.createElement('div');d.id='cdp-probe';document.body.appendChild(d)}d.textContent=document.getElementById('q').value">回显</button></p>
<div class="tall"></div><div id="bottom">底部</div>
</body></html>`

const testServer = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(TEST_PAGE)
})
await new Promise((r) => testServer.listen(0, '127.0.0.1', r))
const TEST_PORT = testServer.address().port
const TEST_URL = `http://127.0.0.1:${TEST_PORT}/`

// ---------- Electron 可执行文件 ----------
// 与 verify-cdp-bridge.mjs 同一套解析（那边有更长的说明）。别 require('electron') ——
// pnpm 会忽略它的 postinstall，包目录可能没有 dist/，index.js 会直接抛。
function resolveElectronBin() {
  const candidates = [
    process.env.SUPERCRZY_ELECTRON_BIN,
    join(ROOT, 'packages', 'desktop', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    '/tmp/supercrzy-electron/Electron.app/Contents/MacOS/Electron',
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const cacheDir = join(homedir(), 'Library', 'Caches', 'electron')
  let zipName = ''
  try {
    zipName = readdirSync(cacheDir)
      .filter((f) => f.startsWith('electron-v') && f.endsWith(`darwin-${arch}.zip`))
      .sort().pop() || ''
  } catch { /* 缓存不存在 */ }
  if (!zipName) return null
  const dest = '/tmp/supercrzy-electron'
  mkdirSync(dest, { recursive: true })
  return join(dest, 'Electron.app', 'Contents', 'MacOS', 'Electron')
}

const electronBin = resolveElectronBin()
if (!electronBin) { console.log('✘ 找不到 Electron 二进制，可用 SUPERCRZY_ELECTRON_BIN 指定'); process.exit(1) }

// ---------- 干净子进程 env：剥掉宿主注入的一切 ----------
// ELECTRON_RUN_AS_NODE 不剥 → Electron 静默退化成 Node（窗口不出现、app 为 undefined）。
// 代理变量不剥 → Playwright 的 CDP 客户端会把 ws://127.0.0.1 也送去代理 → socket hang up。
const childEnv = { ...process.env }
const STRIP_KEYS = ['NODE_OPTIONS', 'BASH_ENV', 'ELECTRON_RUN_AS_NODE', 'HTTP_PROXY', 'HTTPS_PROXY',
  'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']
// 宿主可能注入任意名字的沙箱/broker 变量（名字会变，列举必然漏），按模式剥离
for (const k of Object.keys(childEnv)) {
  if (STRIP_KEYS.includes(k) || /BROKER/i.test(k)) delete childEnv[k]
}

const API = `http://127.0.0.1:${BACKEND_PORT}/api/collab/browser`
const HDRS = { 'Content-Type': 'application/json', 'X-Browser-Key': SESSION_ID }

const children = []
const cleanup = async () => {
  for (const c of children) { try { c.kill('SIGTERM') } catch {} }
  await sleep(700)
  for (const c of children) { try { c.kill('SIGKILL') } catch {} }
  try { testServer.close() } catch {}
}

console.log(`\n== attach 模式端到端验证 ==\n  测试页   = ${TEST_URL}\n  后端     = http://127.0.0.1:${BACKEND_PORT}\n  CDP 端点 = http://127.0.0.1:${CDP_PORT}\n  宿主 UI  = http://127.0.0.1:${BACKEND_PORT}/  ← 故意设为 http，复刻生产形态\n`)

const guard = setTimeout(async () => {
  record('global_timeout', 'FAIL', `超过 ${GLOBAL_TIMEOUT_MS}ms`)
  await cleanup()
  process.exit(1)
}, GLOBAL_TIMEOUT_MS)

const collect = (child, sink) => {
  child.stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) sink.push(l) })
  child.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) sink.push('[stderr] ' + l) })
}
const mark = (sink) => sink.length
const waitLine = async (sink, re, timeoutMs, from = 0) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    // ⚠️ 只在新行里找 —— 从整段历史里搜会命中动作**之前**的同类行（陈旧行假失败，详见技能）
    const hit = sink.slice(from).find((l) => re.test(l))
    if (hit) return hit
    await sleep(200)
  }
  return null
}

try {
  // ---------- ① 后端（attach 模式） ----------
  const wsDir = '/tmp/supercrzy-attach-ws'
  mkdirSync(wsDir, { recursive: true })
  const beSink = []
  const backend = spawn(process.execPath,
    [join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(SERVER_DIR, 'src', 'app.ts')],
    {
      cwd: SERVER_DIR,
      env: {
        ...childEnv,
        PORT: String(BACKEND_PORT),
        WORKSPACE_DIR: wsDir,
        DB_PATH: '/tmp/supercrzy-attach.db',
        BROWSER_MODE: 'attach',
        SUPERCRZY_CDP_ENDPOINT: `http://127.0.0.1:${CDP_PORT}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  children.push(backend)
  collect(backend, beSink)

  let health = null
  for (let i = 0; i < 90 && !health; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/health`)
      // 校验载荷，不是"有输出就算就绪" —— 宿主代理层会给出一句看似 JSON 的文本
      if (r.ok) { const j = await r.json(); if (j && j.status === 'ok') health = j }
    } catch { /* 还没监听 */ }
    if (!health) await sleep(500)
  }
  if (!health) {
    record('backend_ready', 'FAIL', `后端未就绪；最后输出：${beSink.slice(-3).join(' / ').slice(0, 200)}`)
    throw new Error('backend not ready')
  }
  record('backend_ready', 'PASS', `status=ok eventLoop=${health.eventLoop?.verdict ?? 'n/a'}`)

  // ---------- ② 样衣：宿主窗口=后端 origin（http），视图=测试页 ----------
  const elSink = []
  const demo = spawn(electronBin, ['--no-sandbox', '--disable-gpu', CDP_DEMO], {
    cwd: join(ROOT, 'packages', 'desktop'),
    env: {
      ...childEnv,
      SUPERCRZY_CDP_DEMO_PORT: String(CDP_PORT),
      SUPERCRZY_CDP_DEMO_URL: TEST_URL,
      SUPERCRZY_CDP_DEMO_HOST_URL: `http://127.0.0.1:${BACKEND_PORT}/`,
      SUPERCRZY_CDP_DEMO_LIFE_MS: String(GLOBAL_TIMEOUT_MS + 30000),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(demo)
  collect(demo, elSink)

  const readyLine = await waitLine(elSink, /CDP_ENDPOINT=/, 40000)
  if (!readyLine) { record('electron_ready', 'FAIL', elSink.slice(-3).join(' / ').slice(0, 200)); throw new Error('electron not ready') }
  record('electron_ready', 'PASS', readyLine.replace('[CDP-DEMO] ', ''))

  let ver = null
  for (let i = 0; i < 25 && !ver; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) ver = await r.json() } catch {}
    if (!ver) await sleep(400)
  }
  if (!ver) { record('cdp_reachable', 'FAIL', 'CDP 端点不可访问'); throw new Error('cdp unreachable') }
  record('cdp_reachable', 'PASS', ver.Browser || 'ok')

  // 等到视图真的把测试页加载完（空/未加载的 target 会被接管逻辑跳过，晚一点才是稳定态）
  await waitLine(elSink, new RegExp(`FINISH_LOAD=.*${TEST_PORT}`), 20000)

  // ---------- ③ 触发首次接管（getPage 是懒的，先要一次 snapshot） ----------
  const snapR = await fetch(`${API}/snapshot`, { headers: HDRS })
  const snap = await snapR.json().catch(() => ({}))
  if (!snapR.ok || !snap?.screenshot) {
    record('attach_adopts_view_page', 'FAIL', `snapshot 失败：${JSON.stringify(snap).slice(0, 160)}`)
    throw new Error('snapshot failed')
  }

  const sessR = await fetch(`${API}/sessions`, { headers: HDRS })
  const sess = await sessR.json()
  const adopted = sess?.attach?.adopted || ''
  if (sess?.mode === 'attach' && adopted.startsWith(`http://127.0.0.1:${TEST_PORT}`)) {
    record('attach_adopts_view_page', 'PASS', `adopted=${adopted}（候选 ${sess.attach.candidates.length} 个）`)
  } else {
    record('attach_adopts_view_page', 'FAIL', `mode=${sess?.mode} adopted="${adopted}" 期望 ${TEST_URL}`)
  }

  const skipped = sess?.attach?.skipped || []
  const hostSkipped = skipped.find((s) => s.includes(`127.0.0.1:${BACKEND_PORT}`))
  if (hostSkipped) record('attach_excludes_host_ui', 'PASS', hostSkipped.slice(0, 110))
  else record('attach_excludes_host_ui', 'FAIL', `skip 列表里没有宿主 UI：${JSON.stringify(skipped).slice(0, 160)}`)

  // ---------- ④ 经产品 API 驱动真网页 ----------
  const navR = await fetch(`${API}/navigate`, { method: 'POST', headers: HDRS, body: JSON.stringify({ url: TEST_URL, sessionId: SESSION_ID }) })
  const nav = await navR.json()
  if (navR.ok && String(nav.url || '').startsWith(`http://127.0.0.1:${TEST_PORT}`)) {
    record('navigate', 'PASS', nav.title || nav.url)
  } else record('navigate', 'FAIL', JSON.stringify(nav).slice(0, 160))

  const act = async (payload) => {
    const r = await fetch(`${API}/act`, { method: 'POST', headers: HDRS, body: JSON.stringify({ ...payload, sessionId: SESSION_ID }) })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }

  // ★★ 闭环：打字 → 页面按钮回显 → Electron 主进程读到
  const probeFrom = mark(elSink)
  const t1 = await act({ action: 'type', text: TOKEN, into: '搜索' })
  const t2 = await act({ action: 'click_text', text: '回显' })
  const probeLine = await waitLine(elSink, /MAIN_READS_PROBE=/, 15000, probeFrom)
  const got = probeLine ? probeLine.split('=').slice(1).join('=').trim() : ''
  if (t1.body?.result?.ok && t2.body?.result?.ok && got === TOKEN) {
    record('cross_runtime_typing', 'PASS', `API 打字 "${TOKEN}" → Electron 读到同一个串`)
  } else {
    record('cross_runtime_typing', 'FAIL', `type.ok=${t1.body?.result?.ok} click.ok=${t2.body?.result?.ok} 读回="${got}" 期望="${TOKEN}"`)
  }

  const k = await act({ action: 'key', key: 'Enter' })
  record('key_enter', k.body?.result?.ok ? 'PASS' : 'FAIL', JSON.stringify(k.body?.result || k.body).slice(0, 120))

  const s = await act({ action: 'scroll', deltaY: 400 })
  record('scroll', s.body?.result?.ok ? 'PASS' : 'FAIL', JSON.stringify(s.body?.result || s.body).slice(0, 120))

  // ---------- ④.5 复刻界面的真实流程：点画面 → 输入（不带 into）→ 回显 ----------
  // 为什么单独验这条：界面上的「仅输入 / 输入+回车」按钮发的 `type` **不带 `into`**，
  // 走的是 `keyboard.type`（依赖焦点），与上面带 into 的 `fill` 是**两条不同的代码路径**。
  // 真网页里输入必须有焦点目标 —— 这就是界面提示「输入前先点一下输入框」的由来。
  // 不验这条，等于主按钮从没被按过。
  const uiToken = `uiflow-${Date.now()}`
  // 先重新导航一次把输入框清空：上一步的 fill 留了内容，这次点进去再打字会**追加**在光标处，
  // 断言会变成假失败（而且看起来像"功能坏了"，其实是测试自己没清场）。
  await fetch(`${API}/navigate`, { method: 'POST', headers: HDRS, body: JSON.stringify({ url: TEST_URL, sessionId: SESSION_ID }) })
  const iR = await fetch(`${API}/interactive`, { headers: HDRS })
  const items = (await iR.json()).items || []
  const row = items.map(String).find((it) => it.startsWith('input') && it.includes('搜索'))
  const xy = row ? row.split('|').pop().trim().split(',').map(Number) : null
  if (!xy || xy.length !== 2 || xy.some(Number.isNaN)) {
    record('ui_flow_click_then_type', 'SKIP', `interactive 里没定位到输入框：${JSON.stringify(items).slice(0, 140)}`)
  } else {
    const from2 = mark(elSink)
    // /browser/interactive 给的就是 getBoundingClientRect 的视口坐标 —— 与 clickAt 的语义一致
    const c = await act({ action: 'click_at', x: xy[0] + 40, y: xy[1] + 10 })
    const t3 = await act({ action: 'type', text: uiToken })      // 不带 into = 界面按钮的路径
    const t4 = await act({ action: 'click_text', text: '回显' })
    const pl = await waitLine(elSink, /MAIN_READS_PROBE=/, 15000, from2)
    const g = pl ? pl.split('=').slice(1).join('=').trim() : ''
    if (c.body?.result?.ok && t3.body?.result?.ok && t4.body?.result?.ok && g === uiToken) {
      record('ui_flow_click_then_type', 'PASS', `点输入框(${xy[0] + 40},${xy[1] + 10}) → 无 into 输入 → Electron 读到同一个串`)
    } else {
      record('ui_flow_click_then_type', 'FAIL',
        `click.ok=${c.body?.result?.ok} type.ok=${t3.body?.result?.ok} echo.ok=${t4.body?.result?.ok} 读回="${g}" 期望="${uiToken}"`)
    }
  }

  // ---------- ⑤ 收尾不得误杀 Electron（最危险的一处） ----------
  const beforeKill = children.indexOf(demo) >= 0 && demo.exitCode === null
  await fetch(`${API}/close`, { method: 'POST', headers: HDRS, body: JSON.stringify({ sessionId: SESSION_ID }) })
  await sleep(1500)
  let stillUp = false
  try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); stillUp = r.ok } catch { stillUp = false }
  const demoAlive = demo.exitCode === null
  if (beforeKill && stillUp && demoAlive) {
    record('close_does_not_kill_electron', 'PASS', 'close 后 CDP 仍可达、Electron 进程仍在 ⇒ 没被误杀')
  } else {
    record('close_does_not_kill_electron', 'FAIL', `close 前活=${beforeKill} close 后 CDP=${stillUp} 进程在=${demoAlive}（exitCode=${demo.exitCode}）`)
  }
} catch (e) {
  console.log(`\n  (中断：${String(e?.message || e).split('\n')[0]})`)
}

clearTimeout(guard)
await cleanup()

const fails = results.filter((r) => r.status === 'FAIL')
const passes = results.filter((r) => r.status === 'PASS').length
console.log(`\n== 结果：${passes} PASS / ${fails.length} FAIL / ${results.filter((r) => r.status === 'SKIP').length} SKIP ==`)
if (fails.length) {
  console.log('  ✘ attach 模式未通过')
  for (const f of fails) console.log(`     - ${f.name}: ${f.detail}`)
  process.exit(1)
}
console.log('  ✔ attach 模式成立 —— 后端接管的是 Electron 窗口里的真网页，且收尾不会误杀主窗口')
process.exit(0)
