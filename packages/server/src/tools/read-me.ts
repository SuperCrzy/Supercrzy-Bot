/**
 * read_me — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { join } from 'path'
import { readFile, access } from 'fs/promises'
import { constants } from 'fs'
import { WORKSPACE_ROOT, assertSafeFilePath } from '../services/sandbox'

const tool: ToolDef = {
    name: 'read_me',
    description: '读取项目的可视化操作指南（README.md / .agents/skills/README.md 等），了解当前工作区的约定、目录结构和用法。适合任务开始前快速了解项目背景。',
    category: 'file',
    parameters: {
      type: 'object',
      properties: {
        maxLength: { type: 'number', description: '最大读取字符数，默认 8000' },
      },
    },
  async execute(args, ctx) {
    const cwd = ctx?.cwd || WORKSPACE_ROOT
    const candidates = ['README.md', 'README.zh-CN.md', '.agents/skills/README.md', 'SUPERCRZY_AGENT_参考手册.md']
    for (const name of candidates) {
      const p = join(cwd, name)
      const guard = assertSafeFilePath(p, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
      if (guard) continue
      try {
        await access(p, constants.F_OK)
        const content = await readFile(p, 'utf-8')
        const max = Math.min(Number(args.maxLength) || 8000, content.length)
        const sliced = content.slice(0, max)
        return `已读取可视化指南：${name}（${content.length} 字符）\n\n${sliced}${max < content.length ? '\n\n…（已截断，共 ' + content.length + ' 字符）' : ''}`
      } catch { /* 尝试下一个 */ }
    }
    return '未找到可视化指南文件（README.md / .agents/skills/README.md）。可先用 file_search 查找项目文档。'
  },
}

export default tool
