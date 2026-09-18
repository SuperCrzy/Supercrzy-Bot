/**
 * terminal_list — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { terminalList } from '../services/terminal-manager'

const tool: ToolDef = {
    name: 'terminal_list',
    description: '列出当前所有终端会话（id/运行状态/shell/cwd）。',
    category: 'terminal',
    parameters: { type: 'object', properties: {} },
  async execute() {
    const list = terminalList()
    if (list.length === 0) return '当前没有终端会话。用 terminal_open 打开一个。'
    return '终端会话：\n' + list.map((s) => `- ${s.id} [${s.running ? '运行中' : '已退出'}] shell=${s.shell} cwd=${s.cwd}`).join('\n')
  },
}

export default tool
