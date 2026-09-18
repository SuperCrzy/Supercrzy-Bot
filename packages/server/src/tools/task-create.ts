/**
 * task_create — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { getDB } from '../services/database'
import { randomUUID } from 'crypto'

const tool: ToolDef = {
    name: 'task_create',
    description: 'Create a new task with optional sub-tasks. Use for planning and tracking work.',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        session_id: { type: 'string', description: 'Associated session ID' },
        subtasks: { type: 'array', items: { type: 'object', properties: { subject: { type: 'string' }, description: { type: 'string' } } }, description: 'Sub-tasks' },
      },
      required: ['subject'],
    },
  async execute(args) {
    const db = getDB()
    const id = randomUUID()
    db.prepare(
      'INSERT INTO tasks (id, session_id, subject, description, status) VALUES (?, ?, ?, ?, ?)'
    ).run(id, args.session_id || null, args.subject, args.description || '', 'pending')

    // Auto-create sub-tasks if provided
    if (Array.isArray(args.subtasks)) {
      for (let i = 0; i < args.subtasks.length; i++) {
        const sub = args.subtasks[i]
        db.prepare(
          'INSERT INTO tasks (id, session_id, parent_id, subject, description, status, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(randomUUID(), args.session_id || null, id, sub.subject || sub, sub.description || '', 'pending', i)
      }
    }

    return `Task created: [${id}] "${args.subject}" ${args.subtasks ? `with ${args.subtasks.length} sub-tasks` : ''}`
  },
}

export default tool
