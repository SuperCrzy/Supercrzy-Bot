/**
 * git_diff — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { runGit } from './shared'

const tool: ToolDef = {
  name: 'git_diff',
  description: '查看工作区 git 变更内容。staged=true 看已暂存，默认看未暂存。',
  category: 'git',
  parameters: { type: 'object', properties: { staged: { type: 'boolean', description: '是否看已暂存的变更' } } },
  async execute(args, ctx) {
    const target = args.staged ? '--cached' : ''
    return runGit(`git diff ${target}`, ctx?.cwd, 'Git 变更')
  },
}

export default tool
