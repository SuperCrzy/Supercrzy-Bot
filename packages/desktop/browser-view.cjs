/**
 * AI 浏览器「原生视图」管理器（2026-09-23）
 *
 * 为什么是 `WebContentsView`（而不是 `<webview>` / iframe）：
 *   - iframe：跨域站点会被 X-Frame-Options / CSP 直接拒，等于什么都打不开
 *   - `<webview>`：在 DOM 里、布局自动跟随，但 Electron 官方标注 "not recommended"，
 *     且长期方向就是被 `WebContentsView` 取代 —— 新代码不该再上这条船
 *   - `WebContentsView`：官方推荐路径，代价是它**不在 DOM 里**（原生合成层），
 *     位置尺寸必须由渲染进程量出来、经 IPC 手动同步（见 setBounds 注释）
 *
 * 这个模块只做"把一页真网页放进宿主窗口的一个矩形里"，不管它显示的是什么。
 * 页面地址由后端（AI 或人）驱动，视图只是**同一份 DOM 的另一扇窗**。
 *
 * 抽成工厂（而不是直接写在 main.cjs）是为了可验证：main.cjs 会连带起后端/tray/更新器，
 * 拿它做端到端验证噪音太大；这里可以注入一个最小 harness 直接驱动。
 */

/** 独立存储分区：AI 浏览的网站有自己的 cookie/localStorage，够不到 App 自己的那份 */
const PARTITION = 'persist:supercrzy-ai-browser'

/**
 * 把渲染进程量出来的矩形归一成 Electron 能接受的 bounds。
 *
 * 两个必须做的处理（都是"错了会以奇怪方式失败"的类型）：
 *   · **必须整数**：`setBounds` 收浮点会抛；`getBoundingClientRect()` 返回的正是浮点
 *   · **宽高最小 1**：0 宽高会让视图静默消失（看起来像"视图没建出来"）
 * 负坐标夹到 0：视图跑到窗口外时应当贴在边缘可见，而不是消失。
 */
function normalizeBounds(b) {
  const num = (v, fallback) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    x: Math.max(0, Math.round(num(b && b.x, 0))),
    y: Math.max(0, Math.round(num(b && b.y, 0))),
    width: Math.max(1, Math.round(num(b && b.width, 0))),
    height: Math.max(1, Math.round(num(b && b.height, 0))),
  }
}

/** 同一个错误在 1.5s 内只报一次：loadURL 的 reject 与 did-fail-load 会各报一次同一个原因 */
const ERROR_DEDUPE_MS = 1500

/**
 * @param {object} opts
 * @param {()} opts.getHostWindow       取宿主 BrowserWindow（窗口可能被重建，所以用回调而不是实例）
 * @param {Function} opts.WebContentsView
 * @param {object} opts.shell           electron.shell（外链兜底）
 * @param {(msg: string, extra?: object) => void} [opts.log]
 */
function createBrowserViewManager(opts) {
  const { WebContentsView, shell } = opts
  const log = opts.log || (() => {})
  const getHostWindow = opts.getHostWindow

  let view = null
  let added = false
  let visible = false
  let lastBounds = null
  let lastError = null
  let lastErrorAt = 0
  let popupCount = 0

  const host = () => {
    const win = getHostWindow && getHostWindow()
    return win && !win.isDestroyed() ? win : null
  }

  /** 把状态推给前端（导航失败/新窗口被就地接管 这类"否则只能看到白屏"的事件） */
  function emit(type, payload) {
    const win = host()
    if (!win) return
    try { win.webContents.send('browser-view:status', { type, at: Date.now(), ...payload }) } catch { /* 窗口在关 */ }
  }

  function reportError(url, message) {
    const now = Date.now()
    if (lastError && lastError.url === url && lastError.message === message && now - lastErrorAt < ERROR_DEDUPE_MS) return
    lastError = { url, message, at: now }
    lastErrorAt = now
    log(`[BrowserView] 导航失败 ${url} → ${message}`)
    emit('load-failed', { url, message })
  }

  function ensure() {
    const win = host()
    if (!win) return null
    if (view && !view.webContents.isDestroyed()) return view

    view = new WebContentsView({
      webPreferences: {
        // 与宿主窗口同等的安全姿态：这是"别人的网页"，绝不带 preload、绝不给 Node
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: PARTITION,
      },
    })
    try { view.setBackgroundColor('#ffffff') } catch { /* 仅影响首帧闪白 */ }
    // 默认静音：AI 自动浏览到带声音的站点时，突然外放比"没声音"更像故障。
    // （人在看视频想听声音的场景，改这一个布尔值即可。）
    try { view.webContents.setAudioMuted(true) } catch { /* 忽略 */ }

    // 新窗口请求：不做多窗口，一律**就地导航**。
    // 理由：attach 模式下"AI 看到的那一页"必须唯一 —— 真开个新窗口，Electron 没有窗口承载它，
    // 结果是"页面消失了但 AI 还在操作它"，比就地导航更难排查。
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        popupCount++
        log(`[BrowserView] 新窗口请求 → 就地导航 ${url}`)
        emit('popup-in-place', { url, count: popupCount })
        navigate(url)
      } else {
        // 非 http(s)（自定义协议、mailto: 等）：不猜、不接管，交给系统或直接拒
        log(`[BrowserView] 拒绝新窗口（非 http）${String(url).slice(0, 60)}`)
        emit('popup-denied', { url: String(url).slice(0, 200) })
        if (shell && /^mailto:|^tel:/i.test(url)) { try { shell.openExternal(url) } catch { /* 忽略 */ } }
      }
      return { action: 'deny' }
    })

    // 导航失败必须看得见：`chrome-error://chromewebdata/` 这类失败态不会走 loadURL 的 catch，
    // 不接这个事件就只剩"白屏且无解释"。
    view.webContents.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      if (code === -3) return // ERR_ABORTED：正常的"被新导航打断"，不是故障
      reportError(validatedURL || '', `did-fail-load ${code} ${desc}`)
    })

    log(`[BrowserView] 已创建视图（partition=${PARTITION}）`)
    return view
  }

  function setBounds(bounds) {
    const v = view
    if (!v || v.webContents.isDestroyed()) return null
    const nb = normalizeBounds(bounds)
    // 只在真的变了才调用：渲染进程每帧都会上报候选矩形（见 DetailPanel 的 rAF 同步），
    // 无脑 setBounds 会持续触发原生重排。
    if (lastBounds && lastBounds.x === nb.x && lastBounds.y === nb.y
      && lastBounds.width === nb.width && lastBounds.height === nb.height) return lastBounds
    v.setBounds(nb)
    lastBounds = nb
    return nb
  }

  /** 显示视图（必要时创建）并把位置摆到 bounds 上 */
  function show(bounds) {
    const win = host()
    if (!win) return null
    const v = ensure()
    if (!v) return null
    const nb = bounds ? normalizeBounds(bounds) : lastBounds
    if (nb) v.setBounds(nb)
    lastBounds = nb
    if (!added) {
      win.contentView.addChildView(v)
      added = true
      log('[BrowserView] 已挂到宿主窗口')
    }
    v.setVisible(true)
    visible = true
    return v
  }

  /** 隐藏但**不销毁**：切走 tab / 折叠侧栏时用（销毁会导致下次显示重新加载，丢失页面状态） */
  function hide() {
    if (view && !view.webContents.isDestroyed()) view.setVisible(false)
    visible = false
  }

  function navigate(url) {
    const v = ensure()
    if (!v) return false
    // 不吞异常：失败要同时经 reportError 告知前端（否则又是白屏无解释）
    v.webContents.loadURL(url).catch((e) => reportError(url, (e && e.message) || String(e)))
    return true
  }

  function destroy() {
    const win = host()
    if (view) {
      try { if (win && added) win.contentView.removeChildView(view) } catch { /* 窗口已销毁 */ }
      try { if (!view.webContents.isDestroyed()) view.webContents.close() } catch { /* 已在关 */ }
    }
    view = null
    added = false
    visible = false
    lastBounds = null
  }

  function getState(extra = {}) {
    const alive = !!view && !view.webContents.isDestroyed()
    return {
      attached: alive && added,
      visible,
      bounds: lastBounds,
      url: alive ? view.webContents.getURL() : '',
      loading: alive ? view.webContents.isLoading() : false,
      audioMuted: true,
      popupsInPlace: popupCount,
      lastError,
      partition: PARTITION,
      ...extra,
    }
  }

  return {
    ensure,
    show,
    hide,
    setBounds,
    navigate,
    destroy,
    getState,
    /** 仅供验证脚本使用：拿到底层 webContents 直接断言 DOM */
    _webContents: () => (view && !view.webContents.isDestroyed() ? view.webContents : null),
    /** 仅供验证脚本使用：读原生层真实 bounds（`getState().bounds` 是"我们设了什么"，这个是"原生认了什么"） */
    _view: () => (view && !view.webContents.isDestroyed() ? view : null),
  }
}

module.exports = { createBrowserViewManager, normalizeBounds, PARTITION }
