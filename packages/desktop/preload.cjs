/**
 * SUPERCRZY BOT — preload 安全桥
 * contextIsolation 开启：只暴露后端状态查询（渲染进程 fetch localhost:3000 走同源策略，
 * file:// 下需经此桥确认后端可用；实际 API 调用仍在渲染进程用 http://localhost:3000）
 *
 * 另含 AI 浏览器「原生视图」桥（2026-09-23）：桌面形态下右栏的网页是一层**原生视图**
 * （WebContentsView，不在 DOM 里），渲染进程只能量出矩形再交给主进程摆位。
 * 纯 Web 形态（浏览器里打开）没有这个桥 → 渲染进程按 `window.supercrzyDesktop?.browserView`
 * 是否存在来决定走原生视图还是走截图流。
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('supercrzyDesktop', {
  /** 查询后端就绪状态：{ status: 'ready'|'starting'|'down', url } */
  backendStatus: () => ipcRenderer.invoke('backend:status'),
  /** 同步主题到窗口标题栏/背景（'dark' | 'light'） */
  setTheme: (theme) => ipcRenderer.send('theme:set', theme),
  /** 后端状态推送（ready/down） */
  onBackendStatus: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('backend-status', listener)
    return () => ipcRenderer.removeListener('backend-status', listener)
  },
  /** 更新检查结果推送（后端代码更新提示，保留兼容） */
  onAppUpdate: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('app-update', listener)
    return () => ipcRenderer.removeListener('app-update', listener)
  },
  /**
   * App 版本口径（2026-10-12）：「应用版本」的唯一权威在主进程 app.getVersion()，
   * 渲染进程不要再自己硬编码或从后端 API 猜。
   * → { version: string, packaged: boolean }
   */
  app: {
    getInfo: () => ipcRenderer.invoke('app:info'),
  },
  /**
   * App 自身自动更新（2026-10-12）：主进程把 electron-updater 状态推给窗口内横幅。
   * status: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'downloaded' | 'error'
   *   idle  = 尚未检查 / 用户关掉了提示
   *   latest= 已检查且确认无新版
   * downloading 带 percent/transferred/total/bytesPerSecond；available/downloaded 带 version。
   */
  update: {
    /** 补拉当前状态（组件挂载时用：事件可能早于订阅） */
    getState: () => ipcRenderer.invoke('update:state'),
    /** 订阅状态推送，返回取消函数 */
    onState: (cb) => {
      const listener = (_e, data) => cb(data)
      ipcRenderer.on('app-update-state', listener)
      return () => ipcRenderer.removeListener('app-update-state', listener)
    },
    /** 手动检查更新（用户主动 ⇒ 失败会提示，不同于启动时的静默检查） */
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    dismiss: () => ipcRenderer.invoke('update:dismiss'),
  },
  /** AI 浏览器原生视图（WebContentsView）控制桥 */
  browserView: {
    /** { bounds, url? } → 状态。只在视图还没有页面时才加载 url（不会顶掉 AI 已导航的页面） */
    show: (payload) => ipcRenderer.invoke('browser-view:show', payload),
    /** 高频：窗口缩放/侧栏折叠时按帧上报矩形（走 send，不产生未决 promise） */
    bounds: (bounds) => ipcRenderer.send('browser-view:bounds', bounds),
    hide: () => ipcRenderer.invoke('browser-view:hide'),
    navigate: (url) => ipcRenderer.invoke('browser-view:navigate', url),
    state: () => ipcRenderer.invoke('browser-view:state'),
    /** 视图事件（load-failed / popup-in-place / popup-denied） */
    onStatus: (cb) => {
      const listener = (_e, data) => cb(data)
      ipcRenderer.on('browser-view:status', listener)
      return () => ipcRenderer.removeListener('browser-view:status', listener)
    },
  },
  isDesktop: true,
})
