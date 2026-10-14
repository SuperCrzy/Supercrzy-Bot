/**
 * task_update — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { getDB } from '../services/database'

const tool: ToolDef = {
    name: 'task_update',
    description: 'Update task status, progress, or subject. Status: pending/in_progress/completed.',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'New status' },
        progress: { type: 'number', description: 'Progress 0-100' },
        subject: { type: 'string', description: 'New subject' },
      },
      required: ['id'],
    },
  async execute(args) {
    const db = getDB()
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.id) as any
    if (!task) return `Task not found: ${args.id}`

    const updates: string[] = []
    if (args.status) { db.prepare('UPDATE tasks SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(args.status, args.id); updates.push(`status → ${args.status}`) }
    if (args.progress !== undefined) { db.prepare('UPDATE tasks SET progress = ?, updated_at = datetime(\'now\') WHERE id = ?').run(args.progress, args.id); updates.push(`progress → ${args.progress}%`) }
    if (args.subject) { db.prepare('UPDATE tasks SET subject = ?, updated_at = datetime(\'now\') WHERE id = ?').run(args.subject, args.id); updates.push(`subject updated`) }

    // ---- 衔接兜底（2026-09-26）：模型把当前步骤标 completed 却没开下一步时，
    // 自动把第一个 pending → in_progress，避免计划出现"没有进行中步骤"的空窗。
    // 这是唯一的自动推进点（启发式衔接），进度主体仍由模型显式声明——不再按轮次盲推。
    let handoffHint = ''
    if (args.status === 'completed' && task.parent_id) {
      const siblings = db.prepare('SELECT * FROM tasks WHERE parent_id=? ORDER BY sort_order').all(task.parent_id) as any[]
      const plan = db.prepare('SELECT * FROM tasks WHERE id=?').get(task.parent_id) as any
      const hasActive = siblings.some((s: any) => s.status === 'in_progress')
      if (plan && plan.status === 'in_progress' && !hasActive) {
        const next = siblings.find((s: any) => s.status === 'pending')
        if (next) {
          db.prepare("UPDATE tasks SET status='in_progress', updated_at=datetime('now') WHERE id=?").run(next.id)
          handoffHint = `\nNext step is now in progress: #${next.subject}（继续执行后同样用 task_update 标记完成）`
        } else if (siblings.length > 0 && siblings.every((s: any) => s.status === 'completed')) {
          // 全部步骤完成 → 根计划同步收尾
          db.prepare("UPDATE tasks SET status='completed', updated_at=datetime('now') WHERE id=?").run(plan.id)
          handoffHint = '\nAll plan steps completed. Plan finished.'
        }
      }
    }

    return updates.length > 0
      ? `Task updated: ${updates.join(', ')}${handoffHint}`
      : `No changes made. Use status/pending, status/in_progress, status/completed, progress/0-100.${handoffHint}`
  },
}

export default tool
