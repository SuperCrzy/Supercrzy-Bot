/**
 * skill_view — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { getDB } from '../services/database'

const tool: ToolDef = {
    name: 'skill_view',
    description: '查看指定技能的完整详情，包括 prompt template 和可用工具。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称（优先精确匹配，支持模糊查找）' },
        id: { type: 'string', description: '技能 UUID' },
      },
    },
  async execute(args) {
    const db = getDB()
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (!name && !id) return 'Usage: skill_view(name="skill-name") or skill_view(id="uuid")'

    let skill: any
    if (id) skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(id)
    else {
      // Duplicate names exist (a skill re-imported while an older copy stayed
      // around). Without an ORDER BY, which row comes back is undefined — the same
      // name could open a different skill on the next call, so instructions changed
      // between attempts with no visible reason. Prefer an enabled copy, then the
      // most-used one, then the oldest: the version the history refers to.
      skill = db.prepare(
        'SELECT * FROM skills WHERE name = ? COLLATE NOCASE ORDER BY enabled DESC, usage_count DESC, created_at ASC LIMIT 1'
      ).get(name)
      // Preserve older calls that passed a UUID in the name field.
      if (!skill && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) {
        skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(name)
      }
      if (!skill) {
        const escaped = name.replace(/[\\%_]/g, '\\$&')
        const matches = db.prepare("SELECT * FROM skills WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 6").all(`%${escaped}%`) as any[]
        if (matches.length > 1) return `Multiple skills match: ${matches.map((row) => row.name).join(', ')}. Use an exact name or id.`
        skill = matches[0]
      }
    }

    if (!skill) return `Skill not found: ${name || id}. Use skill_list() to see available skills.`

    let tools = ''
    try { tools = JSON.parse(skill.tools || '[]').join(', ') || 'none' } catch { tools = skill.tools || 'none' }

    return [
      `=== ${skill.name} ===`,
      `Description: ${skill.description}`,
      `Category: ${skill.category}`,
      `Status: ${skill.enabled ? 'Active' : 'Disabled'}`,
      `Source: ${skill.is_builtin ? 'builtin' : 'installed'}`,
      `Keywords: ${skill.trigger_keywords || 'none'}`,
      `Tools: ${tools}`,
      skill.source_file ? `File: ${skill.source_file}` : '',
      skill.prompt_template ? `\n--- Prompt Template ---\n${skill.prompt_template}` : '',
    ].filter(Boolean).join('\n')
  },
}

export default tool
