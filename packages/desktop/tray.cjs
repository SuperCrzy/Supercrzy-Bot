/**
 * SUPERCRZY BOT — 托盘 + 全局快捷键 + 自动更新提示
 *
 * 依赖 main.cjs 通过 require 注入共享状态（mainWindow/backendReady/quitApp）
 * 职责：
 * 1. 系统托盘图标 + 菜单（显示主窗口 / 检查更新 / 退出）
 * 2. 窗口关闭 → 最小化到托盘（不退出）
 * 3. 全局快捷键 Cmd+Shift+Space 呼出/隐藏
 * 4. 定期检查后端版本 → 有新版本托盘通知
 */
const { Tray, Menu, globalShortcut, Notification, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')

let tray = null

/** 图标：优先用 client/public 的 logo.png，兜底用内置 16x16 纯色 */
function loadIcon() {
  const candidates = [
    path.join(__dirname, '..', '..', 'client', 'public', 'logo.png'),
    path.join(__dirname, '..', '..', '..', 'packages', 'client', 'public', 'logo.png'),
    path.join(process.resourcesPath, 'client-dist', 'logo.png'),
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return nativeImage.createFromPath(p).resize({ width: 18, height: 18 })
    } catch { /* next */ }
  }
  // 兜底：生成一个简单的圆点图标
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><rect width="18" height="18" rx="5" fill="#5b8cff"/><rect x="5" y="5" width="8" height="8" rx="2" fill="#fff"/></svg>`
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
}

/** 创建托盘（app ready 后调用） */
function createTray(ctx) {
  tray = new Tray(loadIcon())
  tray.setToolTip('SUPERCRZY BOT')
  rebuildMenu(ctx)
  // 单击托盘图标：显示/聚焦主窗口
  tray.on('click', () => ctx.showMainWindow())
  return tray
}

/** 重建托盘菜单（状态变化时调用） */
function rebuildMenu(ctx) {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    { label: '打开 SUPERCRZY BOT', click: () => ctx.showMainWindow() },
    { type: 'separator' },
    { label: '检查更新', click: () => ctx.checkUpdate(true) },
    { type: 'separator' },
    { label: '退出', click: () => ctx.quitApp() },
  ])
  tray.setContextMenu(menu)
}

/** 注册全局快捷键：Cmd+Shift+Space 呼出/隐藏 */
function registerGlobalShortcut(ctx) {
  const shortcut = 'CommandOrControl+Shift+Space'
  const ok = globalShortcut.register(shortcut, () => ctx.toggleWindow())
  if (ok) console.log(`[Desktop] Global shortcut registered: ${shortcut}`)
  else console.warn(`[Desktop] Global shortcut ${shortcut} registration failed (可能被其他应用占用)`)
}

/** 释放全局快捷键 */
function unregisterShortcuts() {
  globalShortcut.unregisterAll()
}

/** 桌面通知 */
function notify(ctx, title, body) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon: loadIcon() })
  n.on('click', () => ctx.showMainWindow())
  n.show()
}

module.exports = { createTray, rebuildMenu, registerGlobalShortcut, unregisterShortcuts, notify }
