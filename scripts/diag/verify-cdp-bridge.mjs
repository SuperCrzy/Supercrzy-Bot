/**
 * CDP 桥接端到端验证 (2026-09-23)
 *
 * 配合 packages/desktop/cdp-demo.cjs 使用：本脚本**自己拉起**那个 Electron 样衣窗口，
 * 然后用 Playwright `connectOverCDP` 接管它，验证「AI 与人操作同一个核」是否成立。
 *
 * 八项判据（`SKIP` 不算失败，但必须打印原因，避免用代理指标造出假警报）：
 *   1 electron_ready        Electron 打印了 CDP_ENDPOINT
 *   2 cdp_reachable         http://127.0.0.1:<port>/json/version 可访问
 *   3 connect_over_cdp      Playwright 接管成功，拿到 browser.version()
 *   4 page_visible          能看到 WebContentsView 里的那个 page
 *   5 drive_read            能读到它的 url/title
 *   6 same_dom              ★ Playwright 注入的元素，Electron 侧读得到（同一个 DOM 的判决性证据）
 *   7 drive_click           能点链接并使页面导航（无链接时 SKIP）
 *   8 screenshot            能截到非空画面
 *
 * 用法（必须在「干净 env」下跑，见技能 clean-shell-env）：
 *   node scripts/diag/verify-cdp-bridge.mjs
 * 退出码：0 = 核心判据全过；1 = 有 FAIL。
 */
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

const PORT = Number(process.env.SUPERCRZY_CDP_DEMO_PORT || 9333)
const ENDPOINT = `http://127.0.0.1:${PORT}`
const TARGET_URL = process.env.SUPERCRZY_CDP_DEMO_URL || 'https://example.com'
const TOKEN = `probe-${Date.now()}`
const GLOBAL_TIMEOUT_MS = 150000

// playwright-core 在 server 包里（本仓库唯一一份被部署的）
const pw = require(join(ROOT, 'packages', 'server', 'node_modules', 'playwright-core'))
const CDP_DEMO = join(ROOT, 'packages', 'desktop', 'cdp-demo.cjs')

/**
 * 拿一个**能用的** Electron 可执行文件。
 *
 * ⚠️ 不要 `require('packages/desktop/node_modules/electron')` —— pnpm 忽略了 electron 的
 * postinstall 脚本，包目录里**没有 `dist/`、也没有 `path.txt`**，index.js 会直接抛
 * `Electron failed to install correctly`。同理 `pnpm --filter @supercrzy/desktop dev|start`
 * 在本机也是坏的（走的就是同一个 cli.js）。
 * 而 electron-builder 是自己下 Electron 的，缓存在 ~/Library/Caches/electron/ —— 就地解出来用。
 */
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
      .sort()
      .pop() || ''
  } catch { /* 缓存目录不存在 */ }
  if (!zipName) return null

  const dest = '/tmp/supercrzy-electron'
  mkdirSync(dest, { recursive: true })
  console.log(`  (解出 Electron: ${zipName} → ${dest})`)
  try {
    execFileSync('/usr/bin/ditto', ['-x', '-k', join(cacheDir, zipName), dest], { stdio: 'ignore' })
  } catch (e) {
    console.log('  (ditto 解压失败: ' + String(e?.message || e).split('\n')[0] + ')')
    return null
  }
  const bin = join(dest, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  return existsSync(bin) ? bin : null
}

const electronBin = resolveElectronBin()
if (!electronBin) {
  console.log('✘ 找不到可用的 Electron 二进制。可用 SUPERCRZY_ELECTRON_BIN=/path/to/Electron 指定，')
  console.log('  或先执行：pnpm --filter @supercrzy/desktop exec node node_modules/electron/install.js')
  process.exit(1)
}

const results = []
const record = (name, status, detail) => {
  results.push({ name, status, detail: String(detail ?? '') })
  const mark = status === 'PASS' ? 'ok  ' : status === 'SKIP' ? 'skip' : 'FAIL'
  console.log(`  [${mark}] ${name.padEnd(18)} ${String(detail ?? '').slice(0, 120)}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 拉起 Electron 样衣（干净 env：宿主的 NODE_OPTIONS shim 会被 Electron 继承并搞坏窗口）----
const childEnv = { ...process.env }
delete childEnv.NODE_OPTIONS
delete childEnv.BASH_ENV
delete childEnv.ELECTRON_RUN_AS_NODE
delete childEnv.CODEBUDDY_BROKERED_FS_HOOK_ENABLED
delete childEnv.CODEBUDDY_SANDBOX_BROKER_IPC_ADDRESS
delete childEnv.CODEBUDDY_SAFE_DELETE_BROKER_DELETE
delete childEnv.CODEBUDDY_BROKERED_BIN_DIR
delete childEnv.CODEBUDDY_BROKERED_SHELL_ENV

// ⚠️ 代理变量必须剥掉 —— 宿主给 shell 注入了 HTTP(S)_PROXY=http://127.0.0.1:<port>（沙箱出口代理），
//    且**没有 NO_PROXY**。Electron 子进程整体继承后，页面载入会 ERR_FAILED，
//    连浏览器级 CDP 的 WebSocket 升级都会被掐成 "socket hang up"（2026-09-23 实测）。
//    正式 App 从 Finder 双击启动时环境里没有这些变量，所以剥掉才是**真实形态**；
//    之前把"沙箱产物"误读成"协议不支持"，就是这么踩出来的。
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
const strippedProxy = PROXY_KEYS.filter((k) => childEnv[k])
for (const k of PROXY_KEYS) delete childEnv[k]
if (strippedProxy.length) console.log(`  (已剥代理变量: ${strippedProxy.join(', ')})`)

childEnv.SUPERCRZY_CDP_DEMO_PORT = String(PORT)
childEnv.SUPERCRZY_CDP_DEMO_URL = TARGET_URL
childEnv.SUPERCRZY_CDP_DEMO_LIFE_MS = process.env.SUPERCRZY_CDP_DEMO_LIFE_MS || '120000'

console.log(`\n== CDP 桥接验证 ==\n  electron = ${electronBin}\n  demo     = ${CDP_DEMO}\n  endpoint = ${ENDPOINT}\n  target   = ${TARGET_URL}\n`)

// ⚠️ --no-sandbox / --disable-gpu 是**本机宿主环境的补丁，不是产品要求**。
//    依据（2026-09-23 实测）：在受限宿主里 Chromium 自带沙箱初始化不了，日志出现
//    "Failed to initialize sandbox."，浏览器进程随后 SIGTRAP 崩溃。崩溃带来的连锁假象：
//      · 页面 ERR_FAILED (-2)（网络其实是好的）
//      · /json/version 连不上 → Playwright 报 "WebSocket error: socket hang up"
//        （这句措辞把"403 / 404 / 被掐断"三种故障糊成一句，极易误判成"协议不支持 CDP"）
//    裸握手对照过：不带 Origin / devtools:// / http://127.0.0.1 三种都是 101，不存在 Origin 校验问题。
//    正式 App 从 Finder 启动时没有这一层，故这里加参数只为去掉噪声，不改变被验对象。
const SPAWN_ARGS = ['--no-sandbox', '--disable-gpu', CDP_DEMO]

const child = spawn(electronBin, SPAWN_ARGS, { cwd: join(ROOT, 'packages', 'desktop'), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
const outLines = []
let exited = false
child.stdout.on('data', (d) => {
  for (const l of String(d).split('\n')) {
    if (!l.trim()) continue
    outLines.push(l)
    if (l.includes('[CDP-DEMO]') && !/LOAD_DONE/.test(l)) console.log('  | ' + l.replace('[CDP-DEMO] ', ''))
  }
})
child.stderr.on('data', (d) => {
  const s = String(d)
  if (/error|Error|FATAL/.test(s)) console.log('  ! ' + s.split('\n')[0].slice(0, 200))
})
child.on('exit', (code) => { exited = true; console.log(`\n  (Electron 样衣退出 code=${code})`) })

/**
 * 等一行**新**输出。
 *
 * ⚠️ 必须支持 fromIndex —— 否则会命中历史里的陈旧行，造出假失败/假通过。
 * 实测踩过：drive_click 判据在点击前就有过一条 `NAVIGATED=https://example.com/`（初始加载），
 * 点击后真发生了导航（iana.org），但 waitForLine 返回的是那条旧行 → 与 before 相等 → 误判"没导航"。
 * 规则：任何"某个动作之后应该发生 X"的断言，都必须先取 mark() 再只在新行里找。
 */
const waitForLine = async (re, timeoutMs, fromIndex = 0) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const hit = outLines.slice(fromIndex).find((l) => re.test(l))
    if (hit) return hit
    if (exited) return null
    await sleep(200)
  }
  return null
}
const mark = () => outLines.length
const field = (line) => (line ? line.split('=').slice(1).join('=').trim() : '')

let browser = null
let hardFail = false
const cleanup = async () => {
  try { if (browser) await browser.close() } catch {}
  try { if (!exited) child.kill('SIGTERM') } catch {}
  await sleep(900)
  try { if (!exited) child.kill('SIGKILL') } catch {}
}

const guard = setTimeout(async () => {
  record('global_timeout', 'FAIL', `超过 ${GLOBAL_TIMEOUT_MS}ms 未完成`)
  hardFail = true
  await cleanup()
  process.exit(1)
}, GLOBAL_TIMEOUT_MS)

try {
  // 1 Electron 就绪
  const readyLine = await waitForLine(/CDP_ENDPOINT=/, 40000)
  if (!readyLine) {
    record('electron_ready', 'FAIL', '没等到 CDP_ENDPOINT（窗口没起来 / 端口被占 / Electron 被 env 劫持）')
    hardFail = true
    throw new Error('electron not ready')
  }
  record('electron_ready', 'PASS', `endpoint=${field(readyLine)}`)

  // 2 CDP 端点可访问
  let versionJson = null
  for (let i = 0; i < 25 && !versionJson; i++) {
    try {
      const r = await fetch(`${ENDPOINT}/json/version`)
      if (r.ok) versionJson = await r.json()
    } catch { /* 还没监听 */ }
    if (!versionJson) await sleep(400)
  }
  if (!versionJson) {
    record('cdp_reachable', 'FAIL', `${ENDPOINT}/json/version 不可访问`)
    hardFail = true
    throw new Error('cdp endpoint unreachable')
  }
  record('cdp_reachable', 'PASS', versionJson.Browser || 'ok')

  // 3 Playwright 接管
  try {
    browser = await pw.chromium.connectOverCDP(ENDPOINT)
  } catch (e) {
    record('connect_over_cdp', 'FAIL', String(e?.message || e).split('\n')[0])
    hardFail = true
    throw e
  }
  record('connect_over_cdp', 'PASS', `browser=${browser.version()}`)

  // 4 找到 WebContentsView 里那个 page（把看到的全打出来，便于判断 Playwright 的可见性边界）
  const contexts = browser.contexts()
  const allPages = []
  for (const [ci, ctx] of contexts.entries()) {
    for (const p of ctx.pages()) allPages.push({ ci, p, url: p.url() })
  }
  console.log(`\n  Playwright 看到 contexts=${contexts.length} pages=${allPages.length}`)
  for (const it of allPages) console.log(`    · [ctx${it.ci}] ${it.url.slice(0, 100)}`)

  const hostOf = (u) => { try { return new URL(u).host } catch { return '' } }
  let target = allPages.find((it) => hostOf(it.url) && hostOf(it.url) === hostOf(TARGET_URL))?.p
  if (!target) target = allPages.find((it) => it.url.startsWith('http'))?.p

  if (!target) {
    record('page_visible', 'FAIL', '没看到任何 http(s) page —— WebContentsView 的 target 对 Playwright 不可见')
    hardFail = true
    throw new Error('no page')
  }
  record('page_visible', 'PASS', `url=${target.url().slice(0, 70)}`)

  // 5 读页面
  //    ⚠️ 这里原本写成 `title || target.url() ? 'PASS' : 'FAIL'` —— 运算符优先级让它是
  //    `title || (url ? 'PASS' : 'FAIL')`，title 非空即恒真。这类"恒真断言"比没测试更坏。
  const title = await target.title().catch(() => '')
  record('drive_read', title && target.url() ? 'PASS' : 'FAIL', `title="${title}" url=${target.url().slice(0, 50)}`)

  // 6 ★ 判决性证据：Playwright 注入 → Electron 主进程读得到
  const probeMark = mark()
  await target.evaluate((tk) => {
    const d = document.createElement('div')
    d.id = 'cdp-probe'
    d.textContent = tk
    d.style.cssText = 'position:fixed;top:6px;left:6px;z-index:2147483647;background:#0f6;padding:2px 6px;font:12px sans-serif'
    document.body.appendChild(d)
  }, TOKEN).catch((e) => record('same_dom', 'FAIL', 'evaluate 注入失败: ' + String(e?.message || e).split('\n')[0]))

  const probeLine = await waitForLine(/MAIN_READS_PROBE=/, 12000, probeMark)
  const gotToken = field(probeLine)
  if (probeLine && gotToken === TOKEN) {
    record('same_dom', 'PASS', `Electron 读到 ${gotToken}`)
  } else if (probeLine) {
    record('same_dom', 'FAIL', `读到的是 ${gotToken}，与注入的 ${TOKEN} 不一致`)
    hardFail = true
  } else {
    record('same_dom', 'FAIL', 'Electron 侧始终没读到探针 → 两边不是同一份 DOM')
    hardFail = true
  }

  // 7 点击（无链接则 SKIP，不用代理指标硬判）
  const href = await target.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a[href]')).find((x) => /^https?:/.test(x.href))
    return a ? a.href : ''
  }).catch(() => '')
  if (!href) {
    record('drive_click', 'SKIP', '页面没有可点的 http(s) 链接')
  } else {
    const before = target.url()
    const clickMark = mark()
    await target.click('a[href]', { timeout: 8000 }).catch(() => {})
    const navLine = await waitForLine(/NAVIGATED=/, 12000, clickMark)
    const after = navLine ? field(navLine) : target.url()
    if (navLine && after !== before) record('drive_click', 'PASS', `${before.slice(0, 40)} → ${after.slice(0, 40)}`)
    else if (navLine) record('drive_click', 'FAIL', `导航到了 ${after}，与点击前相同（可能点到了同一页）`)
    else { record('drive_click', 'FAIL', '点击后没发生导航') }
  }

  // 8 截图
  const shot = await target.screenshot({ type: 'jpeg', quality: 60 }).catch(() => Buffer.alloc(0))
  record('screenshot', shot.length > 1000 ? 'PASS' : 'FAIL', `${shot.length} bytes`)

  clearTimeout(guard)
  await cleanup()

  const fails = results.filter((r) => r.status === 'FAIL')
  const passes = results.filter((r) => r.status === 'PASS').length
  console.log(`\n== 结果：${passes} PASS / ${fails.length} FAIL / ${results.filter((r) => r.status === 'SKIP').length} SKIP ==`)
  if (fails.length || hardFail) {
    console.log('  ✘ 判定：CDP 桥接路线**未通过**，不能按方案 D 施工')
    for (const f of fails) console.log(`     - ${f.name}: ${f.detail}`)
    process.exit(1)
  }
  console.log('  ✔ 判定：CDP 桥接路线**成立** —— Playwright 能接管 Electron 内嵌的真网页，且是同一份 DOM')
  process.exit(0)
} catch (e) {
  clearTimeout(guard)
  if (!exited) await cleanup()
  const fails = results.filter((r) => r.status === 'FAIL')
  console.log(`\n== 中断：${String(e?.message || e).split('\n')[0]} ==`)
  console.log(`  已完成判据 ${results.length} 项，其中 FAIL ${fails.length} 项`)
  for (const f of fails) console.log(`     - ${f.name}: ${f.detail}`)
  process.exit(1)
}
