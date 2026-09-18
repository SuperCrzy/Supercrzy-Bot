/**
 * terminal_close — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { terminalClose } from '../services/terminal-manager'

const tool: ToolDef = {
    name: 'terminal_close',
    description: '关闭终端会话（SIGTERM + 1s 强杀兜底）。',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '终端会话 id' },
      },
      required: ['id'],
    },
  async execute(args) {
    if (!args.id) return '❌ 缺少会话 id'
    const res = terminalClose(String(args.id))
    return res.ok ? `✅ 已关闭终端会话 ${args.id}` : `❌ ${res.error}`
  },
}

export default tool
