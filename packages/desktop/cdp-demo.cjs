/**
 * CDP 桥接技术样衣 (2026-09-23)
 *
 * 目的：验证「Electron 窗口内嵌**真网页** + 后端用 Playwright `connectOverCDP` 接管**同一个核**」
 * 这条路线是否成立。它是「AI 浏览器从截图镜像升级为真网页」方案 D 的前置可行性验证。
 *
 * 要验的四件事：
 *  ① Electron 能开出 CDP 端点（`--remote-debugging-port`，必须在 whenReady 之前 appendSwitch）
 *  ② 窗口里能放一个 `WebContentsView` 并载入真实 https 页面（真核，非 iframe）
 *  ③ 另一个**独立进程**的 Playwright 能 `connectOverCDP` 上来，并看到这个 WebContentsView 的 page
 *  ④ **同一个 DOM**：Playwright 注入的元素，Electron 主进程从自己的 webContents 里读得到
 *     （这条是"AI 与人同一个核"的判决性证据 —— 只验 ③ 只能说明"连上了"，验 ④ 才说明"是同一页"）
 *
 * ⚠️ 刻意做成两个进程：生产形态里 Electron 主进程（packages/desktop/main.cjs）
 *    与后端（tsx src/app.ts）本来就是两个进程，同进程验不出真实约束。
 *
 * 环境变量：
 *   SUPERCRZY_CDP_DEMO_PORT=9333         CDP 端口
 *   SUPERCRZY_CDP_DEMO_URL=https://…     要载入的地址
 *   SUPERCRZY_CDP_DEMO_LIFE_MS=90000     最长存活时间（防孤儿窗口）
 *   SUPERCRZY_CDP_DEMO_QUIT=1            打印完立即退出（配合 LIFE_MS=0 做单次观测）
 *
 * 观测方式：stdout 里的 `[CDP-DEMO] KEY=VALUE` 行由 verify-cdp-bridge.mjs 解析。
 * 运行本文件请用「干净 env」（见技能 clean-shell-env）：宿主的 NODE_OPTIONS shim
 * 会被 Electron 继承，导致窗口起不来或行为异常。
 */
const electron = require('electron')
const { app, BrowserWindow } = electron

const PORT = Number(process.env.SUPERCRZY_CDP_DEMO_PORT || 9333)
const TARGET_URL = process.env.SUPERCRZY_CDP_DEMO_URL || 'https://example.com'
const LIFE_MS = Number(process.env.SUPERCRZY_CDP_DEMO_LIFE_MS || 90000)
// 宿主窗口加载什么。默认 data: 占位页；验 attach 的"排除宿主 UI"逻辑时务必设成 http。
const HOST_URL = process.env.SUPERCRZY_CDP_DEMO_HOST_URL || 'data:text/html,<title>HOST-UI</title><h1>宿主窗口</h1>'

const log = (k, v) => console.log(`[CDP-DEMO] ${k}=${v === undefined ? '' : v}`)

// 0) 用户数据目录挪到临时区。
//    两条理由，都不是洁癖：
//    ① 默认会写 ~/Library/Application Support/Electron/，受限沙箱会拦它的 file-delete，
//       进程半残 → 观测量全部失真（曾出现 CDP WS "socket hang up" + 页面 ERR_FAILED）；
//    ② 样衣不该污染用户真实的 Electron profile，更不该和正式 App 抢单例锁。
//    必须在 whenReady 之前设置。
const USER_DATA = process.env.SUPERCRZY_CDP_DEMO_USERDATA || '/tmp/supercrzy-cdp-demo-userdata'
try { app.setPath('userData', USER_DATA) } catch (e) { log('USERDATA_ERR', (e && e.message) || e) }

// ① 必须在 whenReady 之前设置，否则 Chromium 启动时不会监听调试端口
app.commandLine.appendSwitch('remote-debugging-port', String(PORT))
// 新版 Chromium 会校验 WebSocket 的 Origin；CDP 客户端通常不带 Origin，
// 但显式放开可以避开一类"连得上、马上被 403 掉"的坑。
app.commandLine.appendSwitch('remote-allow-origins', '*')

function resolveViewClass() {
  // Electron 30+ 推荐 WebContentsView；BrowserView 已 deprecated 但仍可用（bv-demo.cjs 用过）
  for (const src of [electron, safeRequire('electron/main')]) {
    if (src && src.WebContentsView) return { Ctor: src.WebContentsView, kind: 'WebContentsView' }
  }
  for (const src of [electron, safeRequire('electron/main')]) {
    if (src && src.BrowserView) return { Ctor: src.BrowserView, kind: 'BrowserView' }
  }
  return null
}
function safeRequire(p) {
  try { return require(p) } catch { return null }
}

app.whenReady().then(async () => {
  let host = null
  try {
    host = new BrowserWindow({
      width: 1020, height: 760, show: true,
      title: 'CDP-DEMO: 内嵌真网页（人可直接操作）',
      webPreferences: { contextIsolation: true },
    })
  } catch (e) {
    log('FATAL', 'BrowserWindow 创建失败 ' + (e && e.message))
    app.exit(2)
    return
  }

  // ①.5 宿主窗口必须真的加载一个页面。
  //     空的 BrowserWindow（没 loadURL）在 CDP 里同样是一个 page target，但它的
  //     Page.enable / Runtime.enable / Network.enable **一条都不回**，
  //     Playwright 的 connectOverCDP 会一直等它初始化 → 整整 30s 后抛 Timeout。
  //     实测证据：pw:protocol 日志里 session=EA4C19C7（url="" 那个 target）
  //     的 id 4–11 全部无 RECV，而另一个真页面的 id 16+ 全部正常返回。
  //     ⚠️ 这条对生产同样成立：正式 App 的宿主窗口本来就会加载 client-dist/index.html，
  //     但如果哪天它加载失败/白屏，CDP 接管会**连带失败**——不是各自独立的两件事。
  //
  //     HOST_URL 可注入：生产里宿主 UI 是 **http 地址**（main.cjs 的
  //     `mainWindow.loadURL(activeFrontUrl)`，由内嵌后端 serve），
  //     所以"只认 http(s)"这种判据会误接管 App 自己的界面。
  //     验证 attach 的排除逻辑时**必须**把这个 URL 设成 http，用 data: 会测不出问题。
  try {
    await host.loadURL(HOST_URL)
  } catch (e) {
    log('HOST_LOAD_ERR', String((e && e.message) || e).split('\n')[0].slice(0, 160))
  }

  const resolved = resolveViewClass()
  if (!resolved) {
    log('FATAL', '既无 WebContentsView 也无 BrowserView')
    app.exit(2)
    return
  }
  log('VIEW_KIND', resolved.kind)

  let view = null
  try {
    view = resolved.kind === 'WebContentsView'
      ? new resolved.Ctor({ webPreferences: { contextIsolation: true } })
      : new resolved.Ctor({ webPreferences: { contextIsolation: true } })
  } catch (e) {
    log('FATAL', '视图创建失败 ' + (e && e.message))
    app.exit(2)
    return
  }

  // ② 铺满窗口：WebContentsView 是**原生层叠**，必须在 resize 时同步 bounds
  //    （这正是方案 D 唯一的真工程量 —— 这里先把最小版本跑通）
  try {
    if (resolved.kind === 'WebContentsView') host.contentView.addChildView(view)
    else host.setBrowserView(view)
    const place = () => {
      try {
        const [w, h] = host.getContentSize()
        view.setBounds({ x: 0, y: 0, width: w, height: h })
      } catch { /* 窗口已销毁 */ }
    }
    place()
    host.on('resize', place)
  } catch (e) {
    log('FATAL', '挂载视图失败 ' + (e && e.message))
    app.exit(2)
    return
  }

  const wc = view.webContents
  wc.on('did-navigate', (_e, url) => log('NAVIGATED', url))
  wc.on('did-finish-load', () => log('FINISH_LOAD', wc.getURL()))

  try {
    await wc.loadURL(TARGET_URL)
  } catch (e) {
    // 载入失败也要继续：CDP 挂载能力本身与网络无关，用 about:blank 也能验
    log('LOAD_ERR', String((e && e.message) || e).split('\n')[0].slice(0, 200))
  }
  log('LOADED_URL', wc.getURL())
  log('CDP_ENDPOINT', `http://127.0.0.1:${PORT}`)
  log('READY', 1)

  // ④ 主进程持续轮询页面里的探针。
  //    Playwright 注入后这里应立刻读到 —— 说明**两边操作的是同一份 DOM**。
  //    2026-09-23 改为「每次变化都报」而不是「只报第一次」：
  //    验证多步流程（点输入框 → 输入 → 回显）时每步都会写一个新值，
  //    只报第一次会让第二步之后全部无输出 → 看起来像"没生效"，其实是探针闭嘴了。
  let lastProbe = ''
  let probeChanges = 0
  const timer = setInterval(async () => {
    try {
      const v = await wc.executeJavaScript(
        "(function(){var el=document.getElementById('cdp-probe');return el?String(el.textContent||''):''})()",
      )
      if (v && v !== lastProbe) {
        lastProbe = v
        probeChanges++
        log('MAIN_READS_PROBE', v)
        log('URL_AT_PROBE', wc.getURL())
        log('PROBE_CHANGES', probeChanges)
      }
    } catch { /* 页面正在导航时会抛，忽略 */ }
  }, 600)

  const shutdown = (code) => {
    clearInterval(timer)
    try { if (host && !host.isDestroyed()) host.destroy() } catch {}
    setTimeout(() => app.exit(code), 120)
  }
  if (LIFE_MS > 0) setTimeout(() => { log('AUTO_QUIT', 1); shutdown(0) }, LIFE_MS)
  if (process.env.SUPERCRZY_CDP_DEMO_QUIT === '1') setTimeout(() => shutdown(0), 8000)
})

app.on('window-all-closed', () => app.exit(0))
