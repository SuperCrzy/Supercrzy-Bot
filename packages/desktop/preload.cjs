/**
 * SUPERCRZY BOT — preload 安全桥
 * contextIsolation 开启：只暴露后端状态查询（渲染进程 fetch localhost:3000 走同源策略，
 * file:// 下需经此桥确认后端可用；实际 API 调用仍在渲染进程用 http://localhost:3000）
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
  /** 更新检查结果推送 */
  onAppUpdate: (cb) => {
    const listener = (_e, data) => cb(data)
    ipcRenderer.on('app-update', listener)
    return () => ipcRenderer.removeListener('app-update', listener)
  },
  isDesktop: true,
})
