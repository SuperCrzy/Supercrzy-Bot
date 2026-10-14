/**
 * AI 浏览器「原生视图」端到端验证 (2026-09-23)
 *
 * 验的是什么：**desktop 侧的接线真的能把一页真网页放进窗口，且人和 AI 操作的是同一份 DOM。**
 * 这是「AI 浏览器从截图监控器升级为人机共用的操作面」的最后一段。
 *
 * 与相邻脚本的分工（别混，三者的"证明力"是递进的）：
 *   · verify-cdp-endpoint.mjs     纯逻辑：端口文件解析 / 新鲜度 / 探活 / 回落（45 项，不需要 Electron）
 *   · verify-attach-judge.mts     纯逻辑：从 target 列表里挑哪一页接管（21 项，不需要 Electron）
 *   · verify-cdp-bridge.mjs       协议可行性：Playwright 能不能接上 Electron 的 CDP
 *   · verify-ai-browser-attach.mjs 产品 API：**独立样衣**那一套（自建 WebContentsView 的替身）
 *   · 本脚本                      ★ 真实接线：同一个 Electron 进程里
 *                                 「窗口 fixture 页 + 真 preload + 真 IPC 接线 + WebContentsView」
 *                                 全部用产品代码（browser-view-wiring.cjs），而不是替身。
 *
 * 编排说明（为什么后端不由 harness 起）：
 *   产品的职责划分是 desktop 起后端并把 CDP 端点传下去。这里刻意把"起后端"提到本脚本，
 *   因为端口必须在 Electron 起来之后才知道 —— 让本脚本编排，harness 就只需暴露
 *   `HARNESS_READY cdp=<port>`，两边的职责更清楚，失败时也更容易判断是哪一半。
 *
 * 用法（必须在「干净 env」+ 关外层沙箱下跑；见技能 clean-shell-env）：
 *   node scripts/diag/verify-desktop-attach.mjs
 * 退出码：0 = 全过；1 = 有 FAIL。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createServer } from 'node:net'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const SERVER_DIR = join(ROOT, 'packages', 'server')
const DESKTOP_DIR = join(ROOT, 'packages', 'desktop')
const HARNESS = join(DESKTOP_DIR, 'browser-view-demo.cjs')

const BACKEND_PORT = Number(process.env.DIAG_BACKEND_PORT || 3013)
const GLOBAL_TIMEOUT_MS = 240000
const STALE_PORT = 1 // 故意写进残留端口文件：一个几乎不可能被 Chromium 选中的端口

const results = []
const record = (name, status, detail) => {
  results.push({ name, status, detail: String(detail ?? '') })
  const mark = status === 'PASS' ? 'ok  ' : status === 'SKIP' ? 'skip' : 'FAIL'
  console.log(`  [${mark}] ${name.padEnd(30)} ${String(detail ?? '').slice(0, 150)}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 让内核先挑一个空闲端口再让出来（而后交给 harness 去 listen；竞态窗口极小） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

function resolveElectronBin() {
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
  mkdirSync(dest, { recursive: true })
  return join(dest, 'Electron.app', 'Contents', 'MacOS', 'Electron')
}

const electronBin = resolveElectronBin()
if (!electronBin) { console.log('✘ 找不到 Electron 二进制，可用 SUPERCRZY_ELECTRON_BIN 指定'); process.exit(1) }

// 干净子进程 env：剥掉宿主注入的一切（见技能 clean-shell-env 的"报错措辞会骗人"表）
const childEnv = { ...process.env }
const STRIP_KEYS = ['NODE_OPTIONS', 'BASH_ENV', 'ELECTRON_RUN_AS_NODE', 'HTTP_PROXY', 'HTTPS_PROXY',
  'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']
// 宿主可能注入任意名字的沙箱/broker 变量（名字会变，列举必然漏），按模式剥离
for (const k of Object.keys(childEnv)) {
  if (STRIP_KEYS.includes(k) || /BROKER/i.test(k)) delete childEnv[k]
}

const children = []
const cleanup = async () => {
  for (const c of children) { try { c.kill('SIGTERM') } catch { /* 已退出 */ } }
  await sleep(800)
  for (const c of children) { try { c.kill('SIGKILL') } catch { /* 已退出 */ } }
}

const FIXTURE_PORT = await freePort()
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`
// ⚠️ userData 目录**每轮新建**：CDP 端口文件是按这个目录落的，
//    复用会让"上次运行的残留"混进来（虽然我们专门测了残留处理，但那是单项，不是常态）
const USER_DATA = join(tmpdir(), `supercrzy-harness-ud-${Date.now()}`)
mkdirSync(USER_DATA, { recursive: true })
// 故意先放一个**过期**的端口文件：真 Electron 上来必须无视它
writeFileSync(join(USER_DATA, 'DevToolsActivePort'), `${STALE_PORT}\n/devtools/browser/stale\n`)
const old = new Date(Date.now() - 3600_000)
utimesSync(join(USER_DATA, 'DevToolsActivePort'), old, old)

console.log(`\n== AI 浏览器原生视图 端到端验证 ==
  后端        = http://127.0.0.1:${BACKEND_PORT}
  宿主 fixture = ${FIXTURE_ORIGIN}/   ← 宿主 UI 的角色（必须被排除）
  userData    = ${USER_DATA}
  残留端口文件 = DevToolsActivePort 写着 ${STALE_PORT}（1 小时前）← 必须被无视
`)

const guard = setTimeout(async () => {
  record('global_timeout', 'FAIL', `超过 ${GLOBAL_TIMEOUT_MS}ms`)
  await cleanup()
  process.exit(1)
}, GLOBAL_TIMEOUT_MS)

const collect = (child, sink, prefix = '') => {
  child.stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) sink.push(prefix + l) })
  child.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) sink.push(prefix + '[stderr] ' + l) })
}
const waitLine = async (sink, re, timeoutMs, from = 0) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    // 只在新行里找：从整段历史里搜会命中动作**之前**的同类行（陈旧行假失败，详见技能）
    const hit = sink.slice(from).find((l) => re.test(l))
    if (hit) return hit
    await sleep(200)
  }
  return null
}

const beSink = []
const elSink = []

try {
  // ---------- ① 起 harness（真 Electron + 真接线），它自己开 CDP 端口 ----------
  const wsDir = join(USER_DATA, 'ws')
  mkdirSync(wsDir, { recursive: true })
  const harness = spawn(electronBin, ['--no-sandbox', '--disable-gpu', HARNESS], {
    cwd: DESKTOP_DIR,
    env: {
      ...childEnv,
      SUPERCRZY_HARNESS_USERDATA: USER_DATA,
      SUPERCRZY_HARNESS_BACKEND_PORT: String(BACKEND_PORT),
      SUPERCRZY_HARNESS_FIXTURE_PORT: String(FIXTURE_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(harness)
  collect(harness, elSink)
  // harness 若崩溃/自杀，这里能给出证据（第一版就因为不知道它是"卡住"还是"死了"而多花了一轮）
  let harnessExit = null
  harness.on('exit', (code, signal) => { harnessExit = `code=${code} signal=${signal || 'none'}` })

  const ready = await waitLine(elSink, /HARNESS_READY/, 45000)
  if (!ready) {
    record('harness_ready', 'FAIL', elSink.slice(-4).join(' / ').slice(0, 240))
    throw new Error('harness not ready')
  }
  record('harness_ready', 'PASS', ready.replace('HARNESS_READY ', '').trim())

  const cdpLine = elSink.find((l) => l.includes('HARNESS_CDP_ENDPOINT')) || ''
  const cdpPort = Number((cdpLine.match(/127\.0\.0\.1:(\d+)/) || [])[1] || 0)
  if (!cdpPort) { record('cdp_endpoint_discovered', 'FAIL', cdpLine || 'harness 没打印端点'); throw new Error('no cdp port') }
  const ver = await (async () => {
    for (let i = 0; i < 20; i++) {
      try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`); if (r.ok) return await r.json() } catch { /* 还没听 */ }
      await sleep(300)
    }
    return null
  })()
  record('cdp_endpoint_discovered', ver ? 'PASS' : 'FAIL', `port=${cdpPort} ${ver ? ver.Browser || '' : '不可访问'}`)
  // ★ 残留文件必须被无视：这是我们专门防的一类故障（连到死端口/别人的实例）
  record('stale_port_file_ignored', cdpPort !== STALE_PORT ? 'PASS' : 'FAIL',
    `发现 ${cdpPort}，残留文件写的是 ${STALE_PORT}`)

  // ---------- ② 起后端（attach 模式，端点由 harness 决定）----------
  const backend = spawn(process.execPath,
    [join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(SERVER_DIR, 'src', 'app.ts')],
    {
      cwd: SERVER_DIR,
      env: {
        ...childEnv,
        PORT: String(BACKEND_PORT),
        WORKSPACE_DIR: wsDir,
        DB_PATH: join(USER_DATA, 'harness.db'),
        BROWSER_MODE: 'attach',
        SUPERCRZY_CDP_ENDPOINT: `http://127.0.0.1:${cdpPort}`,
        // 只把 harness 的**宿主页**排除掉（/host），同一台 fixture 服务上的 /content 与 /second
        // 要保持可接管 —— 那两页扮演的是"AI 浏览器要显示的真网页"。
        // 生产里"排除宿主"由「origin + SPA 入口路径」判据自动生效（21 条单测覆盖），
        // 这里用显式排除项，是为了让 harness 的宿主页可以放在任意端口上而不污染生产判据。
        SUPERCRZY_CDP_EXCLUDE: `${FIXTURE_ORIGIN}/host`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  children.push(backend)
  collect(backend, beSink)

  let health = null
  for (let i = 0; i < 90 && !health; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/health`)
      // 校验载荷，不是"有输出就算就绪"
      if (r.ok) { const j = await r.json(); if (j && j.status === 'ok') health = j }
    } catch { /* 还没监听 */ }
    if (!health) await sleep(500)
  }
  if (!health) {
    record('backend_ready', 'FAIL', `后端未就绪；最后输出：${beSink.slice(-3).join(' / ').slice(0, 220)}`)
    throw new Error('backend not ready')
  }
  record('backend_ready', 'PASS', `status=ok eventLoop=${health.eventLoop?.verdict ?? 'n/a'}`)

  // ---------- ③ 等 harness 自己跑完（它拿着 CDP 端口和后端端口，所有 UI 断言都在它那边）----------
  const done = await waitLine(elSink, /HARNESS_DONE/, GLOBAL_TIMEOUT_MS - 60000)
  // harness 的每条 PASS/FAIL 都收进来（它们才是这个功能的核心断言）
  for (const l of elSink) {
    const m = l.match(/^(PASS|FAIL) (\S+)(?: :: (.*))?$/)
    if (m) record(m[2], m[1], m[3] || '')
  }
  if (!done) {
    // 面包屑最后一条 = 卡在哪一步；exit 信息区分"卡住"与"已死"
    const crumbs = elSink.filter((l) => l.includes('HARNESS_STEP'))
    const lastCrumb = crumbs.length ? crumbs[crumbs.length - 1].replace('HARNESS_STEP ', '') : '(无)'
    record('harness_completed', 'FAIL',
      `停在第 ${lastCrumb} 步；harness 进程 ${harnessExit || '仍在运行（= 卡住，没崩）'}；尾部输出：${elSink.slice(-3).join(' / ').slice(0, 200)}`)
  } else {
    record('harness_completed', 'PASS', done.trim())
  }
} catch (e) {
  if (!results.some((r) => r.status === 'FAIL')) record('orchestrator_error', 'FAIL', (e && e.message) || String(e))
} finally {
  clearTimeout(guard)
  await cleanup()
  try { rmSync(USER_DATA, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

const failed = results.filter((r) => r.status === 'FAIL')
const passed = results.filter((r) => r.status === 'PASS')
console.log(`\n== 结果：${passed.length} PASS / ${failed.length} FAIL / ${results.length} 项 ==`)
if (failed.length) {
  for (const f of failed) console.log(`   - ${f.name}: ${f.detail}`)
  console.log('\n  （诊断入口：GET /api/collab/browser/sessions 的 attach 字段会列出每个被跳过的 target 及原因）')
  process.exit(1)
}
console.log('  ✔ 原生视图接线成立（真 preload + 真 IPC + webContents 同核；关会话不杀 Electron）')
process.exit(0)
