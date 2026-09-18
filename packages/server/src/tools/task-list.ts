/**
 * task_list — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { getDB } from '../services/database'

const tool: ToolDef = {
    name: 'task_list',
    description: 'List tasks, optionally filtered by session or status.',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Filter by session' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Filter by status' },
      },
    },
  async execute(args) {
    const db = getDB()
    let query = 'SELECT * FROM tasks WHERE 1=1'
    const params: any[] = []
    if (args.session_id) { query += ' AND session_id = ?'; params.push(args.session_id) }
    if (args.status) { query += ' AND status = ?'; params.push(args.status) }
    query += ' ORDER BY sort_order ASC LIMIT 20'

    const tasks = db.prepare(query).all(...params) as any[]
    if (tasks.length === 0) return args.status ? `No ${args.status} tasks` : 'No tasks found.'

    return tasks.map((t: any) =>
      `${t.status === 'in_progress' ? '▶' : t.status === 'completed' ? '✓' : '○'} [${t.status}] ${t.subject}${t.progress ? ` (${t.progress}%)` : ''}`
    ).join('\n')
  },
}

export default tool
