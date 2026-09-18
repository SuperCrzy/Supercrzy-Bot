/**
 * lint_file — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { readFile, rm } from 'fs/promises'
import { assertSafeFilePath } from '../services/sandbox'
import { resolvePath, lintContent } from './shared'

const tool: ToolDef = {
  name: 'lint_file',
  description: '对文件做静态检查：危险模式（rm -rf 根目录/curl 管道执行等）、凭据泄露、括号配对粗检。写完代码后调用，返回诊断列表（severity/line/message）。',
  category: 'file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件绝对路径' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const path = resolvePath(args.path, ctx?.cwd)
    const guard = assertSafeFilePath(path, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
    if (guard) return `❌ 已拦截（沙箱规则）: ${guard}`
    try {
      const content = await readFile(path, 'utf-8')
      const diagnostics = lintContent(content, path)
      if (diagnostics.length === 0) return '✅ 未发现明显问题'
      return JSON.stringify({ path, count: diagnostics.length, diagnostics })
    } catch (err: any) {
      return `❌ 读取文件失败：${err.message}`
    }
  },
}

export default tool
