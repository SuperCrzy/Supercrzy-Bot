/**
 * skill_list — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { getDB } from '../services/database'

/**
 * Stay under the caller's output cap with room to spare.
 *
 * The hard limit is 16,000 characters. Using 12,000 leaves room for the header line
 * and the trailing note, and means a listing that just fits is not pushed over by
 * a longer skill name later.
 */
const LIST_BUDGET = 12_000

const tool: ToolDef = {
    // get_goal 已迁至 tools/ 目录（ToolDef 注册表，2026-08-25 工具架构轻量包化）——此处不再内联定义，避免工具名重复
    name: 'skill_list',
    description: '列出所有已安装的技能模块。查看 agent 当前具备哪些能力。',
    category: 'system',
    parameters: { type: 'object', properties: {} },
  async execute(_args) {
    const db = getDB()
    const rows = db.prepare(
      'SELECT name, description, category, enabled, is_builtin, trigger_keywords FROM skills ORDER BY sort_order ASC, created_at DESC'
    ).all() as any[]
    if (rows.length === 0) return 'No skills installed.'
    // Tool output is capped at 16,000 characters by the caller. With 200+ skills the
    // full listing runs past 30,000, so everything after the cutoff silently vanished
    // — the model reported a shorter library than exists and answered "I don't have
    // that skill" about entries it never saw. When the listing would not fit, return
    // names only: every skill stays visible, and descriptions come from skill_view.
    const full = rows.map((r: any) => {
      const status = r.enabled ? 'ON' : 'OFF'
      const source = r.is_builtin ? 'builtin' : 'installed'
      return `[${status}] ${r.name} (${r.category}, ${source}) - ${r.description}`
    }).join('\n')
    if (full.length <= LIST_BUDGET) return full
    const names = rows.map((r: any) => {
      const status = r.enabled ? 'ON' : 'OFF'
      return `[${status}] ${r.name} (${r.category})`
    }).join('\n')
    return `${names}\n\n(${rows.length} skills; descriptions omitted to fit — call skill_view(name) for details)`
  },
}

export default tool
