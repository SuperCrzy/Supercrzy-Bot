/**
 * file_exists — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { access } from 'fs/promises'
import { constants } from 'fs'
import { assertSafeFilePath } from '../services/sandbox'
import { resolvePath } from './shared'

const tool: ToolDef = {
  name: 'file_exists',
  description: '检查文件是否存在。',
  category: 'file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
    },
    required: ['path'],    },
  async execute(args, ctx) {
    const path = resolvePath(args.path, ctx?.cwd)
    const guard = assertSafeFilePath(path, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
    if (guard) return `❌ 已拦截（沙箱规则）: ${guard}`
    try {
      await access(path, constants.F_OK)
      return `true - 文件存在：${path}`
    } catch {
      return `false - 文件不存在：${path}`
    }
  },
}

export default tool
