/**
 * terminal_open — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { terminalOpen } from '../services/terminal-manager'
import { resolvePath } from './shared'

const tool: ToolDef = {
  name: 'terminal_open',
  description: '打开一个持久终端会话（仅完全访问权限）。与 shell_exec 一次性执行不同：终端可后台运行长任务、运行交互式程序、多次读取输出。返回会话 id。',
  category: 'terminal',
  parameters: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: '可选：工作目录（默认当前会话工作区）' },
      // 默认值由 terminal-manager 按平台给（Windows: %ComSpec% / cmd.exe，Unix: /bin/bash）。
      shell: { type: 'string', description: 'Optional: shell path. Defaults to cmd.exe on Windows, /bin/bash elsewhere.' },
    },
  },
  async execute(args, ctx) {
    // 权限校验：仅 full 权限可开持久终端（可交互/写，与 shell_exec 只读互补）
    if (ctx?.permissionLevel !== 'full') {
      return '⛔ 终端会话仅"完全访问"权限可用（设置 → 会话权限 → 允许完全访问）。当前为 ' + (ctx?.permissionLevel || 'unknown')
    }
    const cwd = args.cwd ? resolvePath(args.cwd, ctx?.cwd) : ctx?.cwd
    // 不在这里补默认值：写死 '/bin/bash' 会让 Windows 直接 ENOENT（2026-10-26 实机 bug），
    // 平台默认由 terminal-manager 的 defaultShellSpec() 决定。
    const res = terminalOpen(cwd, args.shell)
    return res.ok ? `✅ 终端会话已打开：${res.id}（cwd: ${cwd || process.cwd()}）。用 terminal_send 发命令、terminal_read 读输出。` : `❌ ${res.error}`
  },
}

export default tool
