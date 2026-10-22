/**
 * terminal_signal — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { terminalSignal } from '../services/terminal-manager'

const tool: ToolDef = {
    name: 'terminal_signal',
    description: '向终端会话发送信号：SIGINT 中断当前命令（Ctrl-C）、SIGTERM 终止等。',
    category: 'terminal',
    // SIGINT 放行，其余信号会直接杀掉会话进程 ⇒ 参与授权判定（2026-10-22 P0-1）
    requiresApproval: true,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '终端会话 id' },
        signal: { type: 'string', description: '信号名：SIGINT（默认）/ SIGTERM / SIGHUP 等' },
      },
      required: ['id'],
    },
  async execute(args) {
    if (!args.id) return '❌ 缺少会话 id'
    const sig = String(args.signal || 'SIGINT').toUpperCase()
    const res = terminalSignal(String(args.id), sig)
    return res.ok ? `✅ 已发送 ${sig} 到 ${args.id}` : `❌ ${res.error}`
  },
}

export default tool
