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
const { fileURLToPath } = require('url')
const { autoUpdater } = require('electron-updater')

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

const PORT = Number(process.env.PORT || 3000)
const BACKEND_URL = `http://localhost:${PORT}`
// 当前前端源（dev 模式可能切到 vite dev 5173 实现 HMR 实时同步）
let activeFrontUrl = BACKEND_URL

let backendProc = null
let mainWindow = null
let backendReady = false
const backendWaiters = []
let isQuitting = false
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
  backendProc = spawn(cmd, args, {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), ELECTRON_RUN_AS_NODE: '1' },
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

// ---- App 自动更新（electron-updater）：启动静默检测 → 有新版弹窗询问 → 用户确认才下载安装 ----
// 更新源：打包形态读 electron-builder 生成的 app-update.yml（publish 配置）；dev 形态读 dev-app-update.yml（可指向本地发版源）
let updateCheckedOnce = false
function setupAutoUpdater() {
  if (DEV) {
    // 未打包（dev）形态：强制读 dev-app-update.yml，便于本地测试检测+下载流程
    autoUpdater.forceDevUpdateConfig = true
  }
  autoUpdater.autoDownload = false // 检测到新版只提示，不自动下载
  autoUpdater.autoInstallOnAppQuit = false // 退出时也不强制装，等用户点"重启并安装"

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for update...')
  })

  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Update available: v${info.version}`)
    if (!mainWindow || mainWindow.isDestroyed()) return
    // 手动确认式更新：弹窗询问，用户点"立即更新"才下载
    electron.dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: `SUPERCRZY BOT 有新版本 v${info.version} 可用`,
      detail: '当前版本会先下载更新，下载完成后重启即可完成安装。',
      buttons: ['立即更新', '稍后再说'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.downloadUpdate()
      }
    }).catch(() => {})
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[Updater] Already up to date')
    // 启动静默检测无更新：不打扰用户
  })

  autoUpdater.on('download-progress', (p) => {
    console.log(`[Updater] Download ${Math.round(p.percent)}%`)
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] Downloaded v${info.version}`)
    if (!mainWindow || mainWindow.isDestroyed()) return
    electron.dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '更新已就绪',
      message: `v${info.version} 已下载完成`,
      detail: '重启应用即可完成更新（重启会短暂关闭窗口）。',
      buttons: ['重启并安装', '稍后再说'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        try {
          autoUpdater.quitAndInstall(false, true)
        } catch (e) {
          console.error('[Updater] quitAndInstall failed:', e.message)
          // 未打包 dev 形态无安装器：提示用户手动换新包
          electron.dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: '无法自动安装',
            message: '开发模式下无法自动安装更新，请手动安装新版安装包。',
          }).catch(() => {})
        }
      }
    }).catch(() => {})
  })

  autoUpdater.on('error', (err) => {
    // 网络不通/源未配置时静默（不打扰日常使用），仅记录日志
    console.error('[Updater] error:', err && err.message ? err.message : err)
  })
}

/** 启动后延迟检查一次（不阻塞窗口/后端启动）；非 dev 才检查，dev 下也允许（本地测试） */
function checkForAppUpdate(delayMs = 6000) {
  if (updateCheckedOnce) return
  updateCheckedOnce = true
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => {
      console.error('[Updater] check failed:', e && e.message ? e.message : e)
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
    // App 内嵌后端本机 serve 页面，理应"每次打开即最新"——禁用 Chromium 磁盘 HTTP 缓存，
    // 否则旧静态资源(JS/CSS)会被磁盘缓存命中，导致重打包后仍显示旧设计(老板反馈过)。
    app.commandLine.appendSwitch('disable-http-cache')
    setupAutoUpdater()
    startBackend()
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
    stopBackend()
  })

  app.on('will-quit', () => unregisterShortcuts())
}
