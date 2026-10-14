/**
 * skill_install — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { installSkillFromGitHub, initSkillsDirectory } from '../services/skill-loader'

const tool: ToolDef = {
    name: 'skill_install',
    description: '从 GitHub 安装第三方技能。传入包含 SKILL.md 的 GitHub 仓库 URL。',
    category: 'system',
    requiresApproval: true,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'GitHub 仓库 URL，如 https://github.com/user/skill-repo' },
      },
      required: ['url'],
    },
  async execute(args) {
    const url = args.url || args.github || ''
    if (!url.trim()) return 'Usage: skill_install(url="https://github.com/user/skill-repo")'

    try {
      initSkillsDirectory(process.cwd())
      const result = await installSkillFromGitHub(url.trim(), process.cwd())
      if (result.success) {
        return `Installed skill: ${result.name}\nSkill is now active. Use skill_view(name="${result.name}") to see details.`
      } else {
        return `Install failed: ${result.error}`
      }
    } catch (err: any) {
      return `Skill install error: ${err.message}`
    }
  },
}

export default tool
