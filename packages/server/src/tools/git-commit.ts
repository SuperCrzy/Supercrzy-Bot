/**
 * git_commit — 由注册表管理（P1-03，2026-09-18 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { WORKSPACE_ROOT } from '../services/sandbox'
import { runGit } from './shared'

const tool: ToolDef = {
  name: 'git_commit',
  description: '提交当前工作区全部变更（git add -A + commit）。提交前先 git_status/git_diff 确认变更内容。',
  category: 'git',
  parameters: { type: 'object', properties: { message: { type: 'string', description: '提交信息（清晰描述变更）' } }, required: ['message'] },
  async execute(args, ctx) {
    const msg = String(args.message || '').trim()
    if (!msg) return '❌ git_commit 需要提供 message（提交信息）'
    const parts = [`git add -A`, `git commit -m ${JSON.stringify(msg)}`]
    const cwd = ctx?.cwd || WORKSPACE_ROOT
    const results: string[] = []
    for (const cmd of parts) {
      const r = await runGit(cmd, cwd, cmd.startsWith('git add') ? '暂存' : '提交')
      results.push(r)
      if (r.includes('❌') || r.includes('已拦截')) return results.join('\n')
    }
    return results.join('\n')
  },
}

export default tool
