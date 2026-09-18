/**
 * terminal_read — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { terminalRead } from '../services/terminal-manager'

const tool: ToolDef = {
    name: 'terminal_read',
    description: '增量读取终端会话输出（从上次读取位置；返回 nextOffset 供下次续读）。',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '终端会话 id' },
        offset: { type: 'number', description: '可选：起始读取位置（默认上次消费位置）' },
      },
      required: ['id'],
    },
  async execute(args) {
    if (!args.id) return '❌ 缺少会话 id'
    const res = terminalRead(String(args.id), args.offset ? Number(args.offset) : undefined)
    if (!res.ok) return `❌ ${res.error}`
    if (!res.output) return `（${args.id} 暂无新输出）`
    return `${res.output}\n[输出结束 nextOffset=${res.nextOffset}${res.exited ? ' 会话已退出' : ''}]`
  },
}

export default tool
