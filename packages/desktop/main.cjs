/**
 * SUPERCRZY BOT — Electron 主进程
 *
 * 职责：
 * 1. 创建应用窗口，加载 client 构建产物（packages/client/dist）
 * 2. 内嵌启动后端（spawn tsx src/app.ts，端口 3000），随应用生命周期管理
 * 3. 深链接（supercrzy://）外部唤起
 * 4. 安全：contextIsolation + 最小 preload 桥
 */
const electron = require('electron')
const { app, BrowserWindow, shell } = electron
// electron 33+ 主进程模块可从 'electron/main' 导入（require('electron') 在某些打包形态下不含 ipcMain）
let ipcMain = electron.ipcMain
if (!ipcMain) {
  try { ipcMain = require('electron/main').ipcMain } catch { /* older */ }
}
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { fileURLToPath } = require('url')
const { autoUpdater } = require('electron-updater')
const cdp = require('./cdp-endpoint.cjs')
const { wireBrowserView } = require('./browser-view-wiring.cjs')

// ---- AI 浏览器：CDP 端口 + 原生视图（2026-09-23）----
// 让内嵌后端能 `connectOverCDP` 接管窗口里的**真网页** → 人和 AI 变成同一个页面上的两个操作者。
//
// BOOT_TS 取在这里（模块加载的第一时间）而不是 whenReady 之后：
// Chromium 写 DevToolsActivePort 的时机与我们无关，可能早于这段脚本执行 ——
// 「比 BOOT_TS 早 5 秒以内」的文件仍视为本次启动写的（见 cdp-endpoint.cjs 的 FRESH_MARGIN_MS）。
const BOOT_TS = Date.now()
if (!cdp.cdpDisabled()) {
  // 端口交给 Chromium 自己挑（0 = 自动），避免固定端口撞上别人的调试实例
  app.commandLine.appendSwitch('remote-debugging-port', '0')
  // 只监听回环。CDP 拿到手 = 整个 App 的 JS 执行权，绝不能对外
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
}

// ---- 路径解析：支持 dev（pnpm workspace 根）与打包（extraResources 内）两种形态 ----
const DEV = process.argv.includes('--dev') || !app.isPackaged
function findRoot() {
  // 打包形态：extraResources/backend 下放 server；client/dist 也复制进 resources
  if (!DEV) {
    return path.join(process.resourcesPath, 'backend')
  }
  // dev 形态：monorepo 根（packages/desktop/../.. = 仓库根；__dirname 在 asar/打包下有差异，用 app.getAppPath 兜底）
  const fromDir = __dirname
  return path.resolve(fromDir, '..', '..')
}
const ROOT = findRoot()
const SERVER_DIR = DEV
  ? path.join(ROOT, 'packages', 'server')
  : path.join(process.resourcesPath, 'backend', 'packages', 'server')
const SERVER_ENTRY = path.join(SERVER_DIR, 'src', 'app.ts')

/**
 * 用户工作区（2026-09-21）：
 * 后端大量运行时数据是按 workspaceDir(= process.cwd()) 落的 —— data/skills、data/checkpoints、
 * data/ilink-credentials.json 全在里面。之前 cwd 直接指向 .app 包体（resources/backend/packages/server），
 * 后果有两层：
 *   1) 运行时把「老板自己的微信凭据 / 检查点 / DB」写进 .app；打包时还可能被一起打进 dmg 发给别人
 *   2) 数据落在只读或会被覆盖的位置，升级/重装即丢
 * 现在显式把 WORKSPACE_DIR 指到 ~/.supercrzy —— 与 SQLite（~/.supercrzy/data/supercrzy.db）同处，
 * 包体里不再有任何用户数据。
 */
const USER_WORKSPACE = path.join(os.homedir(), '.supercrzy')

/**
 * 首次运行播种技能：包体只自带「示例技能」（只读），
 * 用户工作区为空时拷一份过去，之后所有增删改都发生在用户目录。
 */
function seedWorkspace() {
  try {
    const target = path.join(USER_WORKSPACE, 'data', 'skills')
    const hasContent = fs.existsSync(target) && fs.readdirSync(target).length > 0
    if (hasContent) return
    const bundled = path.join(SERVER_DIR, 'data', 'skills')
    if (!fs.existsSync(bundled)) return
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.cpSync(bundled, target, { recursive: true })
    console.log(`[Desktop] Seeded bundled skills → ${target}`)
  } catch (e) {
    console.warn('[Desktop] Seed skills failed:', e && e.message)
  }
}

const PORT = Number(process.env.PORT || 3000)
const BACKEND_URL = `http://localhost:${PORT}`
// 当前前端源（dev 模式可能切到 vite dev 5173 实现 HMR 实时同步）
let activeFrontUrl = BACKEND_URL

let backendProc = null
let mainWindow = null
let backendReady = false
const backendWaiters = []
let isQuitting = false
// AI 浏览器原生视图管理器（wireBrowserView 的返回值，仅为退出时清理）
let browserViewManager = null
// 后端崩溃自动重启次数（指数退避，最多 5 次）
let backendRestartAttempt = 0

// ---- 内嵌后端启动 ----
function isPortOpen(port) {
  return new Promise((resolve) => {
    const net = require('net')
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
    setTimeout(() => { socket.destroy(); resolve(false) }, 800)
  })
}

async function waitForBackend(timeoutMs = 30000) {
  if (backendReady) return
  if (backendWaiters.length > 0) {
    return new Promise((r) => backendWaiters.push(r))
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortOpen(PORT)) {
      backendReady = true
      console.log(`[Desktop] Backend ready at ${BACKEND_URL}`)
      backendWaiters.forEach((r) => r())
      backendWaiters.length = 0
      return
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Backend did not start within ${timeoutMs}ms`)
}

async function startBackend() {
  if (await isPortOpen(PORT)) {
    // 端口已被占用：可能是用户已手动启动后端（dev 场景），直接复用
    console.log(`[Desktop] Port ${PORT} already in use, reusing existing backend`)
    backendReady = true
    return
  }
  const entry = SERVER_ENTRY
  if (!fs.existsSync(entry)) {
    console.error(`[Desktop] Server entry not found: ${entry}`)
    return
  }
  // 后端用 tsx 运行；用 Electron 内置 Node 跑 tsx 的 cli.mjs（GUI 双击启动 PATH 精简，
  // 系统 PATH 里没有 node，走 .bin/tsx 的 shebang(env node) 会找不到 node 导致后端起不来 → 白屏）
  const tsxCli = path.join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const cmd = process.execPath
  const args = [tsxCli, entry]
  seedWorkspace()
  // AI 浏览器的接管端点：把"窗口里的真网页"告诉内嵌后端（读 CDP 端口，见 cdp-endpoint.cjs）。
  // 读不到就显式回落 launch —— 宁可退回"截图监控器"，也不要每次操作都报"找不到可接管页面"。
  const attach = await cdp.resolveAttachEnv({ userDataDir: app.getPath('userData'), sinceMs: BOOT_TS })
  console.log(attach.ok
    ? `[Desktop] AI 浏览器：attach 模式（CDP ${attach.endpoint}）`
    : `[Desktop] AI 浏览器：回落 launch（${attach.reason}）`)
  backendProc = spawn(cmd, args, {
    cwd: SERVER_DIR,
    // WORKSPACE_DIR 显式指向用户目录：运行时数据（skills/checkpoints/凭据）不写进 .app 包体
    env: {
      ...process.env,
      PORT: String(PORT),
      WORKSPACE_DIR: USER_WORKSPACE,
      ELECTRON_RUN_AS_NODE: '1',
      ...attach.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  })
  backendRestartAttempt = 0
  backendProc.stdout.on('data', (d) => process.stdout.write(`[Server] ${d}`))
  backendProc.stderr.on('data', (d) => process.stderr.write(`[Server] ${d}`))
  backendProc.on('exit', (code) => {
    console.log(`[Desktop] Backend exited with code ${code}`)
    backendProc = null
    backendReady = false
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('backend-status', { status: 'down' })
    }
    // 应用未退出时后端崩溃 → 自动重启（指数退避 3s→30s，最多 5 次），避免白屏/功能挂死
    if (!isQuitting) {
      backendRestartAttempt++
      if (backendRestartAttempt <= 5) {
        const delay = Math.min(3000 * 2 ** (backendRestartAttempt - 1), 30000)
        console.log(`[Desktop] Backend restarting in ${delay}ms (attempt ${backendRestartAttempt}/5)`)
        setTimeout(() => {
          if (!backendReady && !backendProc) startBackend()
        }, delay)
      } else {
        console.log('[Desktop] Backend restart limit reached, waiting for user action')
      }
    }
  })
  console.log(`[Desktop] Backend spawned: ${cmd} ${args.join(' ')}`)
}

function stopBackend() {
  if (backendProc) {
    backendProc.kill('SIGTERM')
    backendProc = null
  }
}

// ---- dev 模式前端源：优先 vite dev（5173，HMR 实时同步，改代码窗口即时刷新），
// vite 未启动时回退后端 serve 的 dist（3000）。生产/打包（非 --dev）固定用 3000。
async function detectDevFrontend() {
  if (!DEV) return BACKEND_URL
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 900)
    const res = await fetch('http://localhost:5173/', { signal: ctl.signal })
    clearTimeout(timer)
    if (res.ok) {
      console.log('[Desktop] 前端源: vite dev (http://localhost:5173) HMR 实时同步')
      return 'http://localhost:5173'
    }
  } catch { /* vite 未启动 */ }
  console.log('[Desktop] 前端源: 后端 dist (3000)')
  return BACKEND_URL
}

// ---- 深链接（supercrzy://）----
function handleDeepLink(url) {
  if (!url) return
  console.log(`[Desktop] Deep link: ${url}`)
  const target = url.replace(/^supercrzy:\/\//, '').replace(/^\/\//, '')
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 转成前端可读的 hash 参数：supercrzy://chat?q=xxx → /#/?q=xxx
    const hash = target.startsWith('chat') ? '/#' + target.slice(4) : '/#' + target
    mainWindow.loadURL(`${activeFrontUrl}${hash}`)
    mainWindow.focus()
  }
}

// ---- 窗口 ----
// 后端（Koa）单端口同时服务页面 + API（koa-static 托管 client/dist），
// 所以窗口直接加载 http://localhost:3000 —— 页面/API 同源，无需自定义协议。
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'SUPERCRZY BOT',
    backgroundColor: '#ffffff',
    // 沉浸式顶栏（对齐 WorkBuddy）：隐藏原生标题栏，红绿灯嵌入 52px 顶栏
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 21, y: 20 },
      // 去掉 vibrancy（macOS 最大化/全屏时 NSVisualEffectView 会盖住红绿灯导致消失；横栏背景不透明，毛玻璃本无视觉作用）
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 允许开发调试（生产可关闭）
      devTools: true,
    },
  })

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url)
    return { action: 'deny' }
  })

  // 等待后端就绪后加载（后端未起时显示加载中）
  mainWindow.loadURL('data:text/html,<body style="background:#0f1115;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#8a93a6;font-family:system-ui">SUPERCRZY BOT 启动中…</body>')
  waitForBackend(45000).then(async () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      activeFrontUrl = await detectDevFrontend()
      mainWindow.loadURL(activeFrontUrl)
      // 使 Service Worker 缓存失效：App 内嵌后端本机 serve，理应每次打开即最新，
      // 注销 PWA 的 sw 并清 CacheStorage，避免旧 bundle(JS/CSS)被 sw 预缓存锁死显示旧设计。
      mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents
          .executeJavaScript(`
            (async () => {
              try {
                if (navigator.serviceWorker) {
                  const regs = await navigator.serviceWorker.getRegistrations()
                  await Promise.all(regs.map(r => r.unregister()))
                }
                if (window.caches) {
                  const keys = await caches.keys()
                  await Promise.all(keys.map(k => caches.delete(k)))
                }
              } catch (e) { /* 非关键，失败也不影响加载 */ }
            })()
          `)
          .catch(() => {})
      })
      mainWindow.webContents.send('backend-status', { status: 'ready', url: activeFrontUrl })
    }
  }).catch((e) => {
    console.error('[Desktop] Backend not ready:', e.message)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL('data:text/html,<body style="background:#0f1115;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#e24b4a;font-family:system-ui">后端启动失败，请检查日志后重试</body>')
    }
  })

  // 关闭 → 最小化到托盘（不退出；真退出走托盘菜单/应用菜单）
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

// ---- preload 桥 ----
ipcMain.handle('backend:status', async () => {
  if (backendReady) return { status: 'ready', url: BACKEND_URL }
  try { await waitForBackend(8000); return { status: 'ready', url: BACKEND_URL } } catch { return { status: 'starting' } }
})

// 主题同步：前端切换主题 → 窗口标题栏（macOS 红绿灯行）+ 背景色跟随
ipcMain.on('theme:set', (_e, theme) => {
  const dark = theme === 'dark'
  try {
    electron.nativeTheme.themeSource = dark ? 'dark' : 'light'
  } catch { /* older electron */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 与前端 tokens 深色内容区 --bg-primary: #141414 保持一致（避免窗口边缘露黑/露白）
    mainWindow.setBackgroundColor(dark ? '#141414' : '#ffffff')
  }
})

// ---- App 自动更新（electron-updater）----
// 更新源：打包形态读 electron-builder 生成的 app-update.yml（publish 配置）；dev 形态读 dev-app-update.yml（可指向本地发版源）
//
// 2026-10-12 改：状态全部走 IPC 推给窗口内横幅（AppUpdateBanner.vue），不再用系统 dialog。
// 起因：实测「点完立即更新后界面毫无反馈」—— 旧实现里 download-progress 只有一行 console.log，
// 主进程从未把它发给渲染进程；而「发现新版本」走的是 electron.dialog（系统原生窗，不在窗口内），
// 且渲染进程压根没订阅 preload 已暴露的 onAppUpdate。⇒ 现在 main→renderer 单向推 'app-update-state'，
// renderer→main 用 'update:download' | 'update:install' | 'update:dismiss' 操作。
let updateCheckedOnce = false
/** 最近一次更新状态（渲染进程挂载晚于事件时会漏收，用 update:state 补拉） */
let lastUpdateState = { status: 'idle' }

function pushUpdateState(payload) {
  lastUpdateState = { ...lastUpdateState, ...payload }
  console.log(`[Updater] state=${lastUpdateState.status}${lastUpdateState.percent != null ? ` ${Math.round(lastUpdateState.percent)}%` : ''}`)
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-update-state', lastUpdateState)
  } catch { /* 窗口已销毁，忽略 */ }
  // macOS Dock 图标进度：下载中显示，其余传 -1 清除
  try {
    if (app.dock) app.dock.setProgressBar(lastUpdateState.status === 'downloading' ? (lastUpdateState.percent || 0) / 100 : -1)
  } catch { /* 非 mac / Dock 不可用 */ }
}
function setupAutoUpdater() {
  if (DEV) {
    // 未打包（dev）形态：强制读 dev-app-update.yml，便于本地测试检测+下载流程
    autoUpdater.forceDevUpdateConfig = true
  }
  autoUpdater.autoDownload = false // 检测到新版只提示，不自动下载
  autoUpdater.autoInstallOnAppQuit = false // 退出时也不强制装，等用户点"重启并安装"

  autoUpdater.on('checking-for-update', () => {
    pushUpdateState({ status: 'checking' })
  })

  // 不再弹系统对话框：交给窗口内横幅（带「立即更新」按钮）
  autoUpdater.on('update-available', (info) => {
    pushUpdateState({ status: 'available', version: info.version, percent: undefined })
  })

  // 启动静默检测无更新：清状态，不打扰用户
  // 语义区分（2026-10-12 口径统一）：
  //   'latest' = 已检查且确认无新版（设置面板显示「已是最新版本」）
  //   'idle'   = 尚未检查 / 用户手动关掉了提示（设置面板不显示状态胶囊）
  // 以前两者都推 'idle'，导致「已是最新」无法与「还没查」区分。
  autoUpdater.on('update-not-available', () => {
    pushUpdateState({ status: 'latest', version: undefined })
  })

  // 进度必须到界面 —— 这是本次修复的核心（旧实现只有一行 console.log）
  autoUpdater.on('download-progress', (p) => {
    pushUpdateState({
      status: 'downloading',
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    pushUpdateState({ status: 'downloaded', version: info.version, percent: 100 })
  })

  autoUpdater.on('error', (err) => {
    const message = err && err.message ? err.message : String(err)
    console.error('[Updater] error:', message)
    // 以前这里完全静默 ⇒ 失败也没任何反馈；现在横幅给一条轻提示，用户可关掉
    pushUpdateState({ status: 'error', message })
  })
}

// ---- 渲染进程的操作入口（窗口内横幅的按钮走这里）----
// 注意：必须注册在模块顶层，不能放进 setupAutoUpdater（否则随调用次数重复注册）。
ipcMain.handle('update:state', () => lastUpdateState)
ipcMain.handle('update:download', () => {
  // 先切到 downloading，避免「点了按钮 → 首个 progress 事件」之间界面没有反馈
  pushUpdateState({ status: 'downloading', percent: 0 })
  return autoUpdater.downloadUpdate()
    .then(() => ({ ok: true }))
    .catch((e) => {
      const message = e && e.message ? e.message : String(e)
      pushUpdateState({ status: 'error', message })
      return { ok: false, message }
    })
})
ipcMain.handle('update:install', () => {
  try {
    autoUpdater.quitAndInstall(false, true)
    return { ok: true }
  } catch (e) {
    const message = e && e.message ? e.message : String(e)
    // 缺开发者签名（adhoc）时 Squirrel.Mac 会拒绝安装，把真实原因带回界面
    console.error('[Updater] quitAndInstall failed:', message)
    pushUpdateState({ status: 'error', message })
    return { ok: false, message }
  }
})
ipcMain.handle('update:dismiss', () => {
  pushUpdateState({ status: 'idle', version: undefined, percent: undefined, message: undefined })
  return { ok: true }
})

// ---- 版本口径（2026-10-12 统一）----
// 「应用版本」的唯一权威 = app.getVersion()：打包形态读 .app/Contents/Info.plist
// （electron-builder 从 packages/desktop/package.json 的 version 写入），dev 形态读同一个
// package.json —— 两种形态天然一致，无需再靠环境变量注入。
//
// 历史问题：设置「关于」面板把前端硬编码的 APP_VERSION('0.3.0'，那其实是**引擎/代码仓库**版本)
// 当成 App 版本渲染，于是出现「关于说 v0.3.0 已是最新」与「横幅说发现新版本 v1.0.6」并排打架。
// packaged 一并回传，供界面判断是否还有「源码」语境（打包形态无 .git，源码检查恒为误报）。
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  packaged: app.isPackaged,
}))

/** 启动后延迟检查一次（不阻塞窗口/后端启动）；非 dev 才检查，dev 下也允许（本地测试） */
function checkForAppUpdate(delayMs = 6000) {
  if (updateCheckedOnce) return
  updateCheckedOnce = true
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => {
      const message = e && e.message ? e.message : String(e)
      console.error('[Updater] check failed:', message)
      // checkForUpdates 失败只 reject promise、不触发 'error' 事件，必须在这里补状态
      pushUpdateState({ status: 'error', message })
    })
  }, delayMs)
}

// ---- 托盘 + 全局快捷键 + 更新（tray.cjs 通过 ctx 回调主进程能力）----
const { createTray, rebuildMenu, registerGlobalShortcut, unregisterShortcuts, notify } = require('./tray.cjs')

const ctx = {
  showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  },
  toggleWindow() {
    if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.hide()
    } else {
      ctx.showMainWindow()
    }
  },
  quitApp() {
    isQuitting = true
    stopBackend()
    unregisterShortcuts()
    app.quit()
  },
  /** 检查后端版本是否有更新（复用 /api/system/check-update；manual=true 时即使无更新也提示） */
  async checkUpdate(manual = false) {
    // 打包形态没有源码仓库（.app 内无 .git），git 检查必然走到 catch 兜底 ⇒ 恒报「已是最新」。
    // 那是假信号（2026-10-12 实测：git rev-parse 返回 fatal: not a git repository），
    // 会与 App 二进制更新的真实结论冲突，所以打包形态直接不检查源码。
    if (app.isPackaged) {
      if (manual && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app-update', { hasUpdate: false, reason: 'packaged-no-source' })
      }
      return
    }
    try {
      const res = await fetch(`http://localhost:${PORT}/api/system/check-update`)
      if (!res.ok) return
      const data = await res.json()
      if (data.hasUpdate) {
        notify(ctx, 'SUPERCRZY BOT 有更新', `新版本可用（${data.localHead} → ${data.remoteHead}）`)
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app-update', { hasUpdate: true, localHead: data.localHead, remoteHead: data.remoteHead })
        }
      } else if (manual && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app-update', { hasUpdate: false, reason: data.reason || 'latest' })
      }
    } catch { /* 后端未就绪时静默 */ }
  },
}

// ---- 生命周期 ----
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith('supercrzy://'))
    if (url) handleDeepLink(url)
    ctx.showMainWindow()
  })

  app.whenReady().then(async () => {
    // ---- BrowserView 独立样衣模式: 不依赖后端/主窗口, 规避"等3000后端失败→白屏" ----
    if (process.env.SUPERCRZY_BV_DEMO === '1') {
      app.commandLine.appendSwitch('disable-http-cache')
      try { require('./bv-demo.cjs')() } catch (e) { console.error('[BV-DEMO] exec fail', e && e.message || e) }
      return // 不 createWindow/startBackend/tray, 独立验三事即退
    }
    // App 内嵌后端本机 serve 页面，理应"每次打开即最新"——禁用 Chromium 磁盘 HTTP 缓存，
    // 否则旧静态资源(JS/CSS)会被磁盘缓存命中，导致重打包后仍显示旧设计(老板反馈过)。
    app.commandLine.appendSwitch('disable-http-cache')
    setupAutoUpdater()
    startBackend()
    // AI 浏览器原生视图接线（只注册一次；视图本身由渲染进程首次进入浏览器 tab 时惰性创建）
    browserViewManager = wireBrowserView({
      Electron: electron,
      ipcMain,
      getHostWindow: () => mainWindow,
      log: (m) => console.log(m),
    })
    createWindow()
    // ---- BrowserView 最小技术样衣(仅 SUPERCRZY_BV_DEMO=1 触发, 验证"真实共用可drive") 2026-09-04 ----
    if (process.env.SUPERCRZY_BV_DEMO === '1') {
      try { require('./bv-demo.cjs')({ app, BrowserWindow, BrowserView }) } catch (e) { console.error('[BV-DEMO] 启动失败', e && e.message || e) }
    }
    createTray(ctx)
    registerGlobalShortcut(ctx)
    // App 二进制更新：启动后延迟检查一次（静默，有新版弹窗询问）
    checkForAppUpdate(6000)
    // 每 6 小时检查一次后端代码更新（git 版本提示，静默）
    setInterval(() => ctx.checkUpdate(false), 6 * 60 * 60 * 1000)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else ctx.showMainWindow()
    })
  })

  app.on('open-url', (e, url) => {
    e.preventDefault()
    handleDeepLink(url)
  })

  // 窗口全部关闭（macOS dock 点击关闭）→ 不退出，等托盘/快捷键唤起
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    isQuitting = true
    // 先拆原生视图：它的 webContents 是独立进程，不显式关会拖住退出
    try { if (browserViewManager) browserViewManager.destroy() } catch { /* 忽略 */ }
    stopBackend()
  })

  app.on('will-quit', () => unregisterShortcuts())
}
