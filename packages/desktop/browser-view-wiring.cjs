/**
 * AI 浏览器视图的 IPC 接线（2026-09-23）
 *
 * 为什么把这几行从 main.cjs 里抽出来（而不是直接写在里面）：
 *   `main.cjs` 会连带起后端、托盘、自动更新器、单实例锁 —— 拿它做端到端验证噪音太大，
 *   而且它一旦出问题会把"是视图接线错了"和"是别的东西崩了"混在一起。
 *   抽出来之后，一个最小 Electron harness 就能**原样调用同一份接线**（同一批 channel、
 *   同一份 preload 桥），端到端验的还是真实契约，不是复制品。
 *
 * channel 清单（preload.cjs 必须与之一致）：
 *   invoke  browser-view:show      { bounds, url? } → state
 *   send    browser-view:bounds    bounds                    （高频，走 send 不走 invoke）
 *   invoke  browser-view:hide      ()               → state
 *   invoke  browser-view:navigate  url              → state
 *   invoke  browser-view:state     ()               → state
 *   send(渲染) browser-view:status 事件             （导航失败/新窗口被就地接管）
 */
const { createBrowserViewManager } = require('./browser-view.cjs')

/** 视图是否可用的统一答复形状：前端只看 available，不需要知道为什么不可用 */
function unavailable(reason) {
  return { available: false, error: reason, attached: false, visible: false, url: '', bounds: null }
}

/**
 * @param {object} opts
 * @param {object} opts.Electron    electron 主模块（要 WebContentsView / shell）
 * @param {object} opts.ipcMain
 * @param {()}   opts.getHostWindow 取宿主 BrowserWindow
 * @param {(msg: string, extra?: object) => void} [opts.log]
 */
function wireBrowserView(opts) {
  const { Electron, ipcMain, getHostWindow } = opts
  const log = opts.log || ((msg) => console.log(msg))

  if (!Electron || !Electron.WebContentsView) {
    // 老版本 Electron 没有 WebContentsView → 明确降级，而不是让 IPC 挂掉
    log('[BrowserView] 当前 Electron 无 WebContentsView，视图功能不可用')
    for (const ch of ['browser-view:show', 'browser-view:hide', 'browser-view:navigate', 'browser-view:state']) {
      ipcMain.handle(ch, () => unavailable('当前 Electron 版本不支持 WebContentsView'))
    }
    ipcMain.on('browser-view:bounds', () => {})
    return null
  }

  const manager = createBrowserViewManager({
    WebContentsView: Electron.WebContentsView,
    shell: Electron.shell,
    getHostWindow,
    log,
  })

  const state = () => {
    const win = getHostWindow && getHostWindow()
    if (!win || win.isDestroyed()) return unavailable('宿主窗口不可用')
    return { available: true, ...manager.getState() }
  }

  ipcMain.handle('browser-view:state', () => state())

  ipcMain.handle('browser-view:show', (_e, payload) => {
    const { bounds, url } = payload || {}
    const v = manager.show(bounds)
    if (!v) return unavailable('宿主窗口不可用，视图无法创建')
    // ⚠️ 只在"视图还没有页面"时才加载起始页。
    // 每次 show 都 loadURL 会把 AI/人刚刚导航到的页面顶回起始页 ——
    // 那正好切断"人对着 AI 正在看的那一页操作"这条链，是这个功能存在的意义本身。
    const cur = v.webContents.getURL()
    if (url && (!cur || cur === 'about:blank')) manager.navigate(url)
    return state()
  })

  // bounds 用 send：渲染进程窗口缩放时会以帧率上报，走 invoke 会在 IPC 上堆一串未决 promise
  ipcMain.on('browser-view:bounds', (_e, bounds) => {
    try { manager.setBounds(bounds) } catch (e) { log(`[BrowserView] setBounds 失败 ${e && e.message}`) }
  })

  ipcMain.handle('browser-view:hide', () => { manager.hide(); return state() })
  ipcMain.handle('browser-view:navigate', (_e, url) => {
    if (typeof url !== 'string' || !url) return state()
    manager.navigate(url)
    return state()
  })

  return manager
}

module.exports = { wireBrowserView, unavailable }
