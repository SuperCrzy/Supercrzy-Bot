/**
 * file_delete — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { stat, readdir, rm, rmdir } from 'fs/promises'
import { assertSafeFilePath } from '../services/sandbox'
import { resolvePath } from './shared'

const tool: ToolDef = {
  name: 'file_delete',
  description: '删除文件或空目录（危险工具：删除前会弹授权确认）。目录仅支持删除空目录，非空拒绝。',
  category: 'file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要删除的文件/空目录绝对路径' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const path = resolvePath(args.path, ctx?.cwd)
    const guard = assertSafeFilePath(path, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
    if (guard) return `❌ 已拦截（沙箱规则）: ${guard}`
    try {
      const st = await stat(path)
      if (st.isDirectory()) {
        // 目录删除：仅空目录（防误删整目录树）
        const entries = await readdir(path)
        if (entries.length > 0) return `❌ 目录非空（${entries.length} 项），拒绝删除。请先清空或只删单个文件。`
        await rmdir(path)
        return `✅ 已删除空目录：${path}`
      }
      await rm(path, { force: true })
      return `✅ 已删除文件：${path}`
    } catch (err: any) {
      return `❌ 删除失败：${err.message}`
    }
  },
}

export default tool
