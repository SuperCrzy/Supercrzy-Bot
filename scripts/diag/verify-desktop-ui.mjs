/**
 * AI 浏览器「原生视图」真机界面验收 (2026-09-23)
 *
 * 验的是什么：**装好的那个 App、真实的那个右栏，原生视图到底有没有盖在对的位置上。**
 *
 * 与相邻脚本的分工（"证明力"是递进的，别混）：
 *   · verify-cdp-endpoint.mjs      纯逻辑：端口文件解析/新鲜度/探活/回落（不需要 Electron）
 *   · verify-attach-judge.mts      纯逻辑：从 target 列表里挑哪一页接管（不需要 Electron）
 *   · verify-ai-browser-attach.mjs 产品 API + 自建样衣：后端能不能驱动窗口里的真网页
 *   · verify-desktop-attach.mjs    真接线 + 自建 harness 页：IPC/preload/接线原样跑，30 项
 *   · 本脚本                        ★ 真产品 + 真界面：起**完整 desktop 主进程**
 *                                   （main.cjs → 后端 → 窗口 → 真 client 产物），
 *                                   再用 Electron 自己开的 CDP 端口**驱动真实 UI**
 *                                   （点右栏开关 → 点浏览器 tab），最后按真实矩形、
 *                                   真实 DOM、真实 API 三层交叉验证同一件事。
 *
 * 为什么必须有这一层（前四层都盖不到）：
 *   DetailPanel 的原生模式判定（`mode==='attach' && 有桌面桥`）、rAF 量矩形上报、
 *   切 tab 收起 —— 这些只在**真 App 的渲染进程里**才跑得到。harness 用的是自己的页面，
 *   即使全绿也证明不了"老板打开 App 点浏览器 tab 就能用"。
 *
 * 自证真伪的手段（都是"两个独立通道观测同一个对象"）：
 *   ★ navigate_drives_the_view  经产品 API 导航 → 从**视图自己的 CDP target** 读 URL
 *   ★ ai_typing_lands_in_dom    经产品 API 打字 → 从视图 DOM 读回显
 *   ★ human_typing_seen_by_ai   经 Chromium 真实输入管线打字 → 产品 API 读 value
 *
 * 用法（必须「干净 env」+ 关外层沙箱，见技能 clean-shell-env）：
 *   node scripts/diag/verify-desktop-ui.mjs
 * 环境变量：DIAG_UI_PORT（默认 3026）
 * 退出码：0 = 全过；1 = 有 FAIL。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const DESKTOP_DIR = join(ROOT, 'packages', 'desktop')
// 截图落在仓库里（不是 /tmp）：它是"真机对齐"的视觉证据，可复查、也可给 README 用
const SHOT_DIR = join(ROOT, 'docs', 'verify')
const SHOT_PATH = join(SHOT_DIR, 'ai-browser-native-view.png')

const APP_PORT = Number(process.env.DIAG_UI_PORT || 3026)
const SESSION_ID = 'diag-ui'
const TOKEN_AI = `ai-${Date.now()}`
const TOKEN_HUMAN = `human-${Date.now()}`
const GLOBAL_TIMEOUT_MS = 300000

const results = []
const record = (name, status, detail) => {
  results.push({ name, status, detail: String(detail ?? '') })
  const icon = status === 'PASS' ? 'ok  ' : status === 'SKIP' ? 'skip' : 'FAIL'
  console.log(`  [${icon}] ${name.padEnd(30)} ${String(detail ?? '').slice(0, 150)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (n) => console.log(`UI_STEP ${n}`)   // 面包屑：超时/静默死等时能知道死在哪

/**
 * 🔴 凡跨进程（HTTP / CDP / IPC）的等待都必须可超时 —— 这条是踩出来的：
 * 上一轮 harness 静默 180 秒零输出，根因就是 waitFor 里 `await fn()` 而 fn 的 fetch 没有超时，
 * deadline 检查在 await 之后，promise 永不 settle 时整个超时机制形同虚设。
 */
function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}
/** 带超时的 fetch（undici 的连接失败只会给 "fetch failed"，真因在 e.cause，必须一起打） */
async function jget(url, ms = 4000, headers = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, { signal: ctl.signal, headers })
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = text }
    return { ok: r.ok, status: r.status, body }
  } catch (e) {
    const c = e?.cause
    return { ok: false, status: 0, body: null, error: e?.message, cause: c && `${c.code || c.name} ${c.message}` }
  } finally { clearTimeout(timer) }
}
async function jpost(url, payload, ms = 20000, headers = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    })
    const text = await r.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = text }
    return { ok: r.ok, status: r.status, body }
  } catch (e) {
    const c = e?.cause
    return { ok: false, status: 0, body: null, error: e?.message, cause: c && `${c.code || c.name} ${c.message}` }
  } finally { clearTimeout(timer) }
}

// ---------------------------------------------------------------- Electron 二进制
function findElectron() {
  const candidates = [
    process.env.SUPERCRZY_ELECTRON_BIN,
    join(DESKTOP_DIR, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
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
  if (!existsSync(join(dest, 'Electron.app'))) {
    try {
      mkdirSync(dest, { recursive: true })
      require('child_process').execFileSync('unzip', ['-q', '-o', join(cacheDir, zipName), '-d', dest], { stdio: 'ignore' })
    } catch { return null }
  }
  const p = join(dest, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  return existsSync(p) ? p : null
}
const electronBin = findElectron()
if (!electronBin) { console.log('✘ 找不到 Electron 二进制，可用 SUPERCRZY_ELECTRON_BIN 指定'); process.exit(1) }

/**
 * 干净子进程 env：剥掉宿主注入的一切。
 * 少剥任何一个都会得到**指向错误方向**的报错（详见技能 clean-shell-env）：
 *   ELECTRON_RUN_AS_NODE → Electron 静默退化成 Node（窗口不出现、app 为 undefined）
 *   HTTP(S)_PROXY        → Playwright 的 CDP 客户端会走代理 → socket hang up
 *   BASH_ENV / NODE_OPTIONS → brokered shell 与 language-shim 注入
 */
const childEnv = { ...process.env }
for (const k of ['NODE_OPTIONS', 'BASH_ENV', 'ELECTRON_RUN_AS_NODE', 'HTTP_PROXY', 'HTTPS_PROXY',
  'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy',
  'CODEBUDDY_BROKERED_FS_HOOK_ENABLED', 'CODEBUDDY_SANDBOX_BROKER_IPC_ADDRESS',
  'CODEBUDDY_SAFE_DELETE_BROKER_DELETE', 'CODEBUDDY_BROKERED_BIN_DIR', 'CODEBUDDY_BROKERED_SHELL_ENV']) {
  delete childEnv[k]
}

// ---------------------------------------------------------------- 临时目录（不碰老板的真实数据）
const RUN_ID = `supercrzy-ui-${Date.now()}`
const USER_DATA = join(tmpdir(), RUN_ID)
mkdirSync(USER_DATA, { recursive: true })
// 后端 DB 指到临时目录：同一个 SQLite 被两个进程写会 SQLITE_BUSY。
// （WORKSPACE_DIR 由 main.cjs 硬编码成 ~/.supercrzy，覆盖不了；但本脚本不跑任何会话任务，
//  只打 /browser/* 路由，不会写检查点/技能。）
const DB_PATH = join(USER_DATA, 'ui.db')

// ---------------------------------------------------------------- fixture：AI 浏览器要显示的那一页
let fixturePort = 0
const fixtureServer = createNetServer()
await new Promise((r) => fixtureServer.listen(0, '127.0.0.1', r))
fixturePort = fixtureServer.address().port
fixtureServer.close()

const CONTENT_PATH = '/content'
const contentHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>fixture</title><style>body{font:16px system-ui;padding:24px}</style></head><body>
<h1 id="h">fixture content</h1>
<input id="q" placeholder="搜索关键词">
<button id="echo" onclick="document.getElementById('probe').textContent=document.getElementById('q').value">回显</button>
<div id="probe"></div>
</body></html>`

const fixture = createServer((req, res) => {
  if (req.url && req.url.startsWith(CONTENT_PATH)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(contentHtml)
    return
  }
  res.writeHead(404); res.end('nope')
})
await new Promise((r) => fixture.listen(fixturePort, '127.0.0.1', r))
const CONTENT_URL = `http://127.0.0.1:${fixturePort}${CONTENT_PATH}`
// 起始页在**应用后端**的 origin 上（127.0.0.1:APP_PORT），与 fixture 不同源 → 可区分
const START_PAGE_URL = `http://127.0.0.1:${APP_PORT}/browser-start.html`

const API = `http://127.0.0.1:${APP_PORT}/api/collab/browser`
const HDRS = { 'Content-Type': 'application/json', 'X-Browser-Key': SESSION_ID }
const apiGet = (p, ms) => jget(`${API}${p}`, ms, { 'X-Browser-Key': SESSION_ID })
const apiPost = (p, payload, ms) => jpost(`${API}${p}`, payload, ms, { 'X-Browser-Key': SESSION_ID })

// ---------------------------------------------------------------- 收尾
let appProc = null
let backendProc = null
let browser = null
let appExit = null
const cleanup = async () => {
  try { if (browser) await withTimeout(browser.close(), 4000, 'browser.close') } catch { /* CDP 已断 */ }
  if (appProc) {
    try { appProc.kill('SIGTERM') } catch { /* 已退出 */ }
    await sleep(1200)
    try { appProc.kill('SIGKILL') } catch { /* 已退出 */ }
  }
  if (backendProc) {
    try { backendProc.kill('SIGTERM') } catch { /* 已退出 */ }
    await sleep(800)
    try { backendProc.kill('SIGKILL') } catch { /* 已退出 */ }
  }
  await sleep(400)
  try { fixture.close() } catch { /* 已关 */ }
}
const hardStop = setTimeout(() => {
  console.log(`\n✘ 全局超时 ${GLOBAL_TIMEOUT_MS}ms，强制收尾`)
  cleanup().finally(() => { printSummary(); process.exit(1) })
}, GLOBAL_TIMEOUT_MS)
hardStop.unref?.()

function printSummary() {
  const pass = results.filter((r) => r.status === 'PASS').length
  const fail = results.filter((r) => r.status === 'FAIL').length
  const skip = results.filter((r) => r.status === 'SKIP').length
  console.log(`\n===== 真机界面验收：${pass} PASS / ${fail} FAIL / ${skip} SKIP =====`)
  for (const r of results) if (r.status === 'FAIL') console.log(`  FAIL ${r.name}: ${r.detail}`)
}

// ---------------------------------------------------------------- 1. 先起后端（不走 App 那条会崩的路）
/**
 * ⚠️ 为什么由本脚本起后端，而不是让 App 自己起（这是**刻意的替身**，不是图方便）：
 *   `main.cjs` 用 `process.execPath`（Electron 二进制）跑 tsx，但仓库里的 better-sqlite3
 *   是按 Node ABI 编译的（实测 127 vs Electron 33 的 130）→ 后端一启动就 ERR_DLOPEN_FAILED、
 *   无限重启。（装机包不受影响：electron-builder 会按 Electron ABI 重建，实测 bundled = 130。）
 *   所以真实 dev 流程本来就依赖"端口上已经有一个 plain-node 后端"—— 本脚本正是扮演那个后端，
 *   让 App 走 `startBackend()` 的"端口已被占用 → 复用"分支（App 日志会打印，脚本会断言它出现）。
 *   产品代码（app.ts / 路由 / ai-browser.ts / 接线 / preload / 前端产物）**全部是原样的**。
 */
const CDP_PORT_FILE = join(USER_DATA, 'cdp-port.txt')
const WORKSPACE_DIR = join(USER_DATA, 'ws')
mkdirSync(WORKSPACE_DIR, { recursive: true })
const tsxCli = join(ROOT, 'packages', 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs')

step(1)
console.log(`[diag] App 端口=${APP_PORT} fixture=${CONTENT_URL}`)
console.log(`[diag] userData=${USER_DATA}`)
backendProc = spawn(process.execPath, [tsxCli, join(HERE, 'diag-backend-launcher.mjs')], {
  cwd: join(ROOT, 'packages', 'server'),
  env: {
    ...childEnv,
    PORT: String(APP_PORT),
    WORKSPACE_DIR,
    DB_PATH,
    BROWSER_MODE: 'attach',        // 让后端进入 attach 模式（产品里由 main.cjs 传）
    DIAG_CDP_PORT_FILE: CDP_PORT_FILE,  // 端点稍后由启动器补进 env（见该文件的注释）
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let backendLog = ''
const collectBackend = (stream, prefix) => {
  stream.on('data', (d) => {
    const s = String(d)
    backendLog += s
    for (const line of s.split('\n')) {
      if (/error|Error|Fatal|listening|started|已绑定/i.test(line) && line.trim()) {
        console.log(`  b| ${prefix}${line.trim().slice(0, 170)}`)
      }
    }
  })
}
collectBackend(backendProc.stdout, '')
collectBackend(backendProc.stderr, '! ')
let backendExit = null
backendProc.on('exit', (code, signal) => { backendExit = `code=${code} signal=${signal || 'none'}` })

// 2. 等后端就绪
step(2)
let health = null
for (let i = 0; i < 60; i++) {
  if (backendExit) break
  const r = await jget(`http://127.0.0.1:${APP_PORT}/api/health`, 2500)
  if (r.ok && r.body && (r.body.status === 'ok' || r.body.ok === true)) { health = r.body; break }
  await sleep(1000)
}
record('backend_ready', health ? 'PASS' : 'FAIL',
  health ? `eventLoop=${health.eventLoop?.verdict || '-'} sse=${health.sse?.active ?? '-'}`
         : `未就绪 backendExit=${backendExit || 'none'} 尾日志=${backendLog.slice(-300).replace(/\n/g, ' | ')}`)
if (!health) { await cleanup(); printSummary(); process.exit(1) }

// 3. 起真实 App（端口已被占用 → 走 startBackend 的"复用已有后端"分支）
step(3)
// 开关必须在 app path **之前**：Electron 把第一个非开关参数当作 app path，
// `--user-data-dir` 放到后面会被当成 App 自己的参数而不是 Chromium 开关。
appProc = spawn(electronBin, ['--no-sandbox', '--disable-gpu', `--user-data-dir=${USER_DATA}`, DESKTOP_DIR, '--dev'], {
  cwd: DESKTOP_DIR,
  env: { ...childEnv, PORT: String(APP_PORT), DB_PATH },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
const collectApp = (stream, prefix) => {
  stream.on('data', (d) => {
    const s = String(d)
    appLog += s
    for (const line of s.split('\n')) {
      if (/attach|CDP|BrowserView|reusing|Error|error/i.test(line) && line.trim()) {
        console.log(`  a| ${prefix}${line.trim().slice(0, 170)}`)
      }
    }
  })
}
collectApp(appProc.stdout, '')
collectApp(appProc.stderr, '! ')
appProc.on('exit', (code, signal) => { appExit = `code=${code} signal=${signal || 'none'}` })

// 4. 等 App 写出 CDP 端口 → 交给后端（晚绑定，见 diag-backend-launcher.mjs 的注释）
step(4)
const portFile = join(USER_DATA, 'DevToolsActivePort')   // Chromium 写的，不是本脚本的 CDP_PORT_FILE
let cdpPort = 0
for (let i = 0; i < 60; i++) {
  if (existsSync(portFile)) {
    const lines = readFileSync(portFile, 'utf8').split('\n')
    const p = Number((lines[0] || '').trim())
    if (p > 0) {
      const v = await jget(`http://127.0.0.1:${p}/json/version`, 1500)
      if (v.ok) { cdpPort = p; break }
    }
  }
  await sleep(500)
}
record('cdp_port_discovered', cdpPort > 0 ? 'PASS' : 'FAIL',
  cdpPort ? `port=${cdpPort}（App 日志：${(appLog.match(/AI 浏览器：[^\n]*/) || ['（复用外部后端，不打印这一行）'])[0]}）` : `未发现 ${portFile}`)
if (!cdpPort) { await cleanup(); printSummary(); process.exit(1) }
writeFileSync(CDP_PORT_FILE, String(cdpPort))

// App 必须真的走了"复用外部后端"这条路（否则它自己 spawn 的 Electron-ABI 后端会崩）
let reuseLogged = false
for (let i = 0; i < 25; i++) { if (/reusing existing backend/i.test(appLog)) { reuseLogged = true; break } await sleep(200) }
record('app_reused_external_backend', reuseLogged ? 'PASS' : 'FAIL',
  reuseLogged ? 'App 未自起后端（走了端口占用复用分支）' : `App 日志未出现复用分支：${appLog.slice(-220).replace(/\n/g, ' | ')}`)

// 后端必须已经把端口绑定成 CDP 端点（绑定晚了会去连默认的 9333）
let bound = false
for (let i = 0; i < 25; i++) { if (backendLog.includes('CDP 端点已绑定')) { bound = true; break } await sleep(200) }
record('backend_bound_cdp_endpoint', bound ? 'PASS' : 'FAIL',
  bound ? `端点 = http://127.0.0.1:${cdpPort}` : '后端日志未出现绑定行')

// 5. attach 模式 + 起始页地址
step(5)
const sess0 = await apiGet('/sessions')
const mode = sess0.body?.mode
record('backend_attach_mode', mode === 'attach' ? 'PASS' : 'FAIL',
  `mode=${mode} startPageUrl=${sess0.body?.startPageUrl || '-'}`)
if (mode !== 'attach') { await cleanup(); printSummary(); process.exit(1) }
record('start_page_url_matches', sess0.body?.startPageUrl === START_PAGE_URL ? 'PASS' : 'FAIL',
  `${sess0.body?.startPageUrl} vs 期望 ${START_PAGE_URL}`)

// 6. 接上，驱动真实 UI
step(6)
const { chromium } = require(join(ROOT, 'packages', 'server', 'node_modules', 'playwright-core'))
try {
  browser = await withTimeout(chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`), 15000, 'connectOverCDP')
  record('cdp_connected', 'PASS', `targets=${browser.contexts()[0]?.pages().length ?? 0}`)
} catch (e) {
  record('cdp_connected', 'FAIL', `${e.message} cause=${e?.cause?.code || ''}`)
  await cleanup(); printSummary(); process.exit(1)
}
const ctx = browser.contexts()[0]

/** 宿主页 = 跑 App UI 的那个 target（localhost:APP_PORT 的 SPA）。每次都重新取，因为窗口会换页。 */
const HOST_RE = new RegExp(`^https?://localhost:(?:${APP_PORT}|3000|5173)/?(\\?|#|$)`)
const findHost = () => ctx.pages().find((p) => HOST_RE.test(p.url()))
/** 视图页 = 除宿主外的那个 http 页面（起始页 / fixture 页都算） */
const findView = () => ctx.pages().find((p) => /^https?:\/\//.test(p.url()) && p !== findHost())

let host = null
for (let i = 0; i < 60; i++) { host = findHost(); if (host) break; await sleep(500) }
record('host_page_found', host ? 'PASS' : 'FAIL', host ? host.url() : `targets=${ctx.pages().map((p) => p.url()).join(' , ')}`)
if (!host) { await cleanup(); printSummary(); process.exit(1) }

const evalHost = (fn, arg) => withTimeout(host.evaluate(fn, arg), 8000, 'host.evaluate')

// 7. preload 桥必须在这个渲染进程里真的存在（这是"桌面形态"的判据）
step(7)
const bridgeType = await evalHost(() => {
  const b = window.supercrzyDesktop?.browserView
  return b ? ['show', 'bounds', 'hide', 'navigate', 'state', 'onStatus'].filter((k) => typeof b[k] !== 'function') : null
}).catch((e) => `ERR ${e.message}`)
record('preload_bridge_present', Array.isArray(bridgeType) && bridgeType.length === 0 ? 'PASS' : 'FAIL',
  Array.isArray(bridgeType) ? (bridgeType.length ? `缺少方法 ${bridgeType.join(',')}` : '6 个方法齐备') : `browserView 不存在：${bridgeType}`)

// 8. 基线：面板默认收起（后面"点开"才有意义）
step(8)
const panelBefore = await evalHost(() => document.querySelector('.detail-panel')?.className || '')
record('panel_hidden_baseline', /visible/.test(panelBefore) ? 'FAIL' : 'PASS',
  /visible/.test(panelBefore) ? `面板一开始就是展开的：${panelBefore}` : `class="${panelBefore}"`)

// 9. 点开右栏（找真按钮：SVG 里那条竖分割线 width/height 唯一）
step(9)
const opened = await evalHost(() => {
  const btns = [...document.querySelectorAll('.traffic-action-btn')]
  const target = btns.find((b) => b.innerHTML.includes('x1="15" y1="3" x2="15" y2="21"'))
  if (!target) return { ok: false, why: `没找到右栏开关，候选=${btns.length}` }
  target.click()
  return { ok: true }
})
let panelVisible = false
for (let i = 0; i < 30; i++) {
  panelVisible = await evalHost(() => /(^|\s)visible(\s|$)/.test(document.querySelector('.detail-panel')?.className || '')).catch(() => false)
  if (panelVisible) break
  await sleep(200)
}
record('panel_opened_by_real_click', opened.ok && panelVisible ? 'PASS' : 'FAIL',
  opened.ok ? `panelVisible=${panelVisible}` : opened.why)

// 10. 点「浏览器」tab
// 🔴 选择器别用 rect 签名：**预览 tab 与浏览器 tab 的 rect 完全一样**（`x=2 y=3 w=20 h=14` +
//    三条线），第一版因此点中了「预览」→ 浏览器 tab 从未激活 → 原生视图当然没建，
//    而报错会让人以为是视图接线坏了。唯一能区分的是浏览器图标多出来的两个小圆点。
step(10)
const tabClicked = await evalHost(() => {
  const tabs = [...document.querySelectorAll('.panel-tab')]
  const target = tabs.find((t) => t.querySelector('.tab-icon circle[cx="11"][cy="7"]'))
  if (!target) return { ok: false, why: `没找到浏览器 tab，候选=${tabs.map((t) => t.textContent.trim()).join('/')}` }
  target.click()
  return { ok: true, label: target.textContent.trim() }
})
let nativeMode = false
for (let i = 0; i < 40; i++) {
  nativeMode = await evalHost(() => !!document.querySelector('.browser-canvas.native')).catch(() => false)
  if (nativeMode) break
  await sleep(250)
}
record('detailpanel_entered_native_mode', tabClicked.ok && nativeMode ? 'PASS' : 'FAIL',
  tabClicked.ok ? `tab=${tabClicked.label} .browser-canvas.native=${nativeMode}` : tabClicked.why)
record('native_note_rendered', nativeMode && (await evalHost(() => !!document.querySelector('.browser-native-note')).catch(() => false)) ? 'PASS' : 'FAIL',
  nativeMode ? '原生模式提示块已渲染（截图命令台已撤）' : '未进原生模式')

// 11. 原生视图真的被建出来了，且正载着起始页
step(11)
let st = null
for (let i = 0; i < 40; i++) {
  st = await evalHost(() => window.supercrzyDesktop.browserView.state()).catch(() => null)
  if (st?.attached && st?.visible && st?.url) break
  await sleep(250)
}
record('view_attached_and_visible', st?.attached && st?.visible ? 'PASS' : 'FAIL',
  st ? `attached=${st.attached} visible=${st.visible} url=${st.url}` : 'state() 取不到')
record('view_loaded_start_page', String(st?.url || '').startsWith(START_PAGE_URL) ? 'PASS' : 'FAIL',
  `url=${st?.url} 期望前缀=${START_PAGE_URL}`)

// 12. ★ 矩形对不对：等它稳定，再拿渲染进程量的矩形比对原生视图实际 bounds
step(12)
const measure = () => evalHost(() => {
  const el = document.querySelector('.browser-canvas')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
}).catch(() => null)
let prev = JSON.stringify(await measure())
for (let i = 0; i < 20; i++) { await sleep(300); const now = JSON.stringify(await measure()); if (now === prev && now !== 'null') break; prev = now }
const rect = JSON.parse(prev || 'null')
const stBounds = (await evalHost(() => window.supercrzyDesktop.browserView.state()).catch(() => null))?.bounds
const near = (a, b) => Math.abs(Number(a) - Number(b)) <= 2
const boundsOk = !!rect && !!stBounds && ['x', 'y', 'width', 'height'].every((k) => near(rect[k], stBounds[k]))
record('bounds_match_placeholder', boundsOk ? 'PASS' : 'FAIL',
  `渲染进程量=${JSON.stringify(rect)} 原生 bounds=${JSON.stringify(stBounds)}`)
record('bounds_not_collapsed', rect && rect.width > 100 && rect.height > 100 ? 'PASS' : 'FAIL',
  rect ? `${rect.width}x${rect.height}` : '量不到矩形')

// 13. ★ 后端接管的是**视图里那一页**（而不是宿主 UI）
step(13)
await apiGet('/snapshot', 15000)
const sess1 = await apiGet('/sessions')
const pages = sess1.body?.pages || []
// ⚠️ key 不是裸 sessionId：`browserKey()` 会加 `wb:` 前缀（幂等前缀，见 ai-browser.ts）。
// 按全等匹配会永远取到空 → 断言"通过"或"失败"都取决于写法，而不是行为。
const mine = pages.find((p) => String(p.key || '').replace(/^wb:/, '') === SESSION_ID)
const adopted = mine?.url || ''
record('backend_adopted_view_page', String(adopted).startsWith(START_PAGE_URL) ? 'PASS' : 'FAIL',
  `key=${mine?.key || '(无)'} 实时 url=${adopted || '(空)'} pages=${JSON.stringify(pages).slice(0, 180)}`)
record('host_ui_not_adopted', pages.some((p) => /localhost:\d+\/?$/.test(p.url || '')) ? 'FAIL' : 'PASS',
  pages.length ? `接管的 ${pages.length} 个页面里没有宿主 SPA 入口（${pages.map((p) => p.url).join(' | ')}）` : '没有任何被接管的页面')

// 14. ★★ 经产品 API 导航 → 从**视图自己的 CDP target** 读 URL（两个独立通道）
step(14)
const navR = await apiPost('/navigate', { url: CONTENT_URL }, 30000)
let viewUrl = ''
for (let i = 0; i < 40; i++) {
  const v = findView()
  viewUrl = v ? v.url() : ''
  if (viewUrl.startsWith(CONTENT_URL)) break
  await sleep(300)
}
record('navigate_drives_the_view', viewUrl.startsWith(CONTENT_URL) ? 'PASS' : 'FAIL',
  `API 返回 url=${navR.body?.url || navR.body?.error || '-'} 视图 CDP target=${viewUrl || '(未找到)'}`)

const view = findView()
if (!view) {
  record('ai_typing_lands_in_dom', 'SKIP', '找不到视图 target')
  record('human_typing_seen_by_ai', 'SKIP', '找不到视图 target')
} else {
  const evalView = (fn) => withTimeout(view.evaluate(fn), 8000, 'view.evaluate')

  // 15. ★★ 经产品 API 打字 → 视图 DOM 里读回显
  step(15)
  const t1 = await apiPost('/act', { action: 'type', text: TOKEN_AI, into: '搜索关键词' }, 20000)
  const t2 = await apiPost('/act', { action: 'click_text', text: '回显' }, 20000)
  let probe = ''
  for (let i = 0; i < 20; i++) {
    probe = await evalView(() => document.getElementById('probe')?.textContent || '').catch(() => '')
    if (probe === TOKEN_AI) break
    await sleep(300)
  }
  record('ai_typing_lands_in_dom', probe === TOKEN_AI ? 'PASS' : 'FAIL',
    `type.ok=${t1.body?.result?.ok} click.ok=${t2.body?.result?.ok} 视图读到="${probe}" 期望="${TOKEN_AI}"`)

  // 16. ★★ 经 Chromium 真实输入管线打字 → 产品 API 读 value
  step(16)
  let humanOk = false, detail15 = ''
  try {
    await withTimeout(evalView(() => { const q = document.getElementById('q'); q.value = ''; q.focus(); return true }), 6000, 'focus')
    await withTimeout(view.keyboard.type(TOKEN_HUMAN, { delay: 12 }), 15000, 'keyboard.type')
    await sleep(400)
    const inter = await apiGet('/interactive', 10000)
    // /browser/interactive 返回的是 **string[]**（`tag | href或value | 文本 | x,y`），不是对象数组 ——
    // 断言要落在**value 那一栏**（下标 1），而不是"整串里包含"：
    // 整串包含的话，placeholder 也叫「搜索关键词」时会把"人根本没打进去"判成通过。
    const items = Array.isArray(inter.body?.items) ? inter.body.items : []
    const valueFields = items.map((s) => String(s).split('|')[1]?.trim() || '')
    humanOk = valueFields.includes(TOKEN_HUMAN)
    detail15 = `API 视角 ${items.length} 个元素，value 栏=[${valueFields.filter(Boolean).join(', ').slice(0, 90) || '全空'}]`
  } catch (e) { detail15 = `${e.message} cause=${e?.cause?.code || ''}` }
  record('human_typing_seen_by_ai', humanOk ? 'PASS' : 'FAIL',
    humanOk ? `键盘打的 "${TOKEN_HUMAN}"，AI 侧 /browser/interactive 读到了` : detail15)

  // 17. 切走 tab → 原生视图必须收起（它盖在 App 界面上，不收就挡住别的 tab）
  step(17)
  const switched = await evalHost(() => {
    const tabs = [...document.querySelectorAll('.panel-tab')]
    const t = tabs.find((x) => !x.querySelector('.tab-icon circle[cx="11"][cy="7"]') && x.textContent.trim() && !x.classList.contains('more-tab'))
    if (!t) return { ok: false }
    t.click()
    return { ok: true, label: t.textContent.trim() }
  })
  let hiddenSt = null
  for (let i = 0; i < 30; i++) {
    hiddenSt = await evalHost(() => window.supercrzyDesktop.browserView.state()).catch(() => null)
    if (hiddenSt && hiddenSt.visible === false) break
    await sleep(250)
  }
  record('tab_switch_hides_view', switched.ok && hiddenSt?.visible === false ? 'PASS' : 'FAIL',
    `切到「${switched.label}」→ visible=${hiddenSt?.visible}`)

  // 18. ★ 切回来不许把页面顶回起始页（这条是功能的立身之本）
  step(18)
  await evalHost(() => {
    const tabs = [...document.querySelectorAll('.panel-tab')]
    const t = tabs.find((x) => x.querySelector('.tab-icon circle[cx="11"][cy="7"]'))
    t?.click()
    return true
  })
  let backSt = null
  for (let i = 0; i < 30; i++) {
    backSt = await evalHost(() => window.supercrzyDesktop.browserView.state()).catch(() => null)
    if (backSt?.visible && backSt?.url) break
    await sleep(250)
  }
  const cur = findView()?.url() || ''
  record('resume_keeps_current_page', String(backSt?.url || cur).startsWith(CONTENT_URL) ? 'PASS' : 'FAIL',
    `切回后 url=${backSt?.url || cur}（应仍在 fixture 页，而不是被顶回起始页）`)

  // 19. 把真实窗口截下来（最好证据：原生层有没有**视觉上**落在占位矩形里）
  // 用宿主页报的屏幕坐标做区域截屏 —— 绕开"拿 macOS 窗口 ID 需要额外工具"这件事。
  // 注意：这是**看**的证据，不是断言；截图失败只 SKIP，不判 FAIL（可能没屏幕录制权限）。
  // 原生层不在宿主渲染树里，`Page.captureScreenshot` 截宿主页拿不到它，所以必须走系统截屏。
  step(19)
  try {
    const geo = await evalHost(() => ({
      x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight,
    }))
    const pad = 16
    const region = `${Math.max(0, Math.round(geo.x - pad))},${Math.max(0, Math.round(geo.y - pad))},${Math.round(geo.w + pad * 2)},${Math.round(geo.h + pad * 2)}`
    mkdirSync(SHOT_DIR, { recursive: true })
    await withTimeout(
      new Promise((res, rej) => {
        const p = spawn('/usr/sbin/screencapture', ['-x', '-o', `-R${region}`, SHOT_PATH], { stdio: 'ignore' })
        p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`screencapture exit=${c}`))))
        p.on('error', rej)
      }), 15000, 'screencapture')
    const bytes = existsSync(SHOT_PATH) ? readFileSync(SHOT_PATH).length : 0
    record('window_screenshot_saved', bytes > 10000 ? 'PASS' : 'SKIP',
      bytes > 10000 ? `${SHOT_PATH}（${Math.round(bytes / 1024)}KB，区域 ${region}）`
                    : `截图过小或失败（${bytes} 字节）—— 可能没有屏幕录制权限，跳过不判失败`)
  } catch (e) {
    record('window_screenshot_saved', 'SKIP', `截屏不可用：${e.message}`)
  }
}

// 20. 释放浏览器不许把 App 一起带走
step(20)
await apiPost('/close', {}, 20000)
await sleep(1500)
const aliveR = await jget(`http://127.0.0.1:${APP_PORT}/api/health`, 4000)
record('browser_close_keeps_app_alive', !appExit && aliveR.ok ? 'PASS' : 'FAIL',
  `appExit=${appExit || 'none'} health.ok=${aliveR.ok}`)

// 21. App 收到 SIGTERM 必须真的退出。
// 这条不是走过场：main.cjs 把窗口的 `close` 事件改成了"隐藏到托盘"（`isQuitting` 才真退），
// 一旦这段逻辑把进程信号也吞掉，收尾就永远清不干净（下一轮会撞上残留的窗口/端口）。
step(21)
try { appProc.kill('SIGTERM') } catch { /* 已退出 */ }
for (let i = 0; i < 40; i++) { if (appExit) break; await sleep(300) }
record('app_exit_on_sigterm', appExit ? 'PASS' : 'FAIL',
  appExit ? `appExit=${appExit}` : '12s 内未退出')

// 22. 脚本自身的收尾（不是产品行为，但漏了会污染下一轮：残留后端会让下次"复用"到脏实例）
try { backendProc.kill('SIGTERM') } catch { /* 已退出 */ }
let released = false
for (let i = 0; i < 30; i++) {
  const r = await jget(`http://127.0.0.1:${APP_PORT}/api/health`, 1500)
  if (!r.ok) { released = true; break }
  await sleep(300)
}
record('harness_teardown_releases_port', released ? 'PASS' : 'FAIL',
  released ? `端口 ${APP_PORT} 已释放` : `端口 ${APP_PORT} 仍被占用（下一轮会复用脏实例）`)

await cleanup()
try { rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* 非关键 */ }
clearTimeout(hardStop)
printSummary()
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0)
