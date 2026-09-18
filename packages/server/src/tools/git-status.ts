/**
 * git_status — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { runGit } from './shared'

const tool: ToolDef = {
  name: 'git_status',
  description: '查看工作区 git 状态（已修改/新增/删除文件）。',
  category: 'git',
  parameters: { type: 'object', properties: {} },
  async execute(args, ctx) {
    return runGit('git status --short', ctx?.cwd, 'Git 状态')
  },
}

export default tool
