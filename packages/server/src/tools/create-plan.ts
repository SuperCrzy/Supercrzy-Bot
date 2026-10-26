/**
 * create_plan — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { getDB } from '../services/database'
import { randomUUID } from 'crypto'

const tool: ToolDef = {
    name: 'create_plan',
    description: '创建多步骤执行计划（多步计划）。任务较复杂（>2 步）时先规划步骤再执行，前端展示计划卡片跟踪进度。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '计划标题' },
        description: { type: 'string', description: '计划说明' },
        steps: { type: 'array', items: { type: 'object', properties: { subject: { type: 'string', description: '步骤标题' }, description: { type: 'string' } } }, description: '步骤列表（2-8 步）' },
        session_id: { type: 'string', description: 'Associated session ID' },
      },
      required: ['title', 'steps'],
    },
  async execute(args, ctx) {
    const db = getDB()
    const title = String(args.title || args.subject || '').trim()
    if (!title) return '❌ create_plan 需要提供 title（计划标题）'
    const steps: Array<{ subject: string; description?: string }> = Array.isArray(args.steps)
      ? args.steps.map((s: any) => (typeof s === 'string' ? { subject: s } : { subject: s.subject || '', description: s.description }))
      : []
    if (steps.length === 0) return '❌ create_plan 需要提供 steps（步骤列表）'

    // 先创建计划根任务（session 归属：模型传的 session_id 优先，否则用 ctx 注入兜底）
    const planSessionId = args.session_id || ctx?.sessionId || null
    const planId = randomUUID()
    db.prepare(
      'INSERT INTO tasks (id, session_id, subject, description, status, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(planId, planSessionId, title, args.description || '', 'in_progress', 0)

    // 每个步骤创建子任务；第一步立即进入 in_progress（驱动前端进度推进）
    const stepIds: string[] = []
    for (let i = 0; i < steps.length; i++) {
      const stepId = randomUUID()
      db.prepare(
        'INSERT INTO tasks (id, session_id, parent_id, subject, description, status, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(stepId, planSessionId, planId, steps[i].subject, steps[i].description || '', i === 0 ? 'in_progress' : 'pending', i + 1)
      stepIds.push(stepId)
    }
    // 🔴 2026-10-26 修：原来只返回标题和步骤文字，plan_id 与每个 step 的 task id **全部丢弃**。
    // 模型拿不到 id ⇒ 后续想调 task_update 只能自己编 ⇒ 恒报 "Task not found"，
    // 计划卡片永远停在第一步（实机报告「计划进度断裂」）。
    // 现在按 task_create 的既有格式（`Task created: [id]`）把 id 一起交出去。
    return (
      `📋 计划已创建: "${title}"，共 ${steps.length} 步。plan_id: ${planId}\n` +
      steps
        .map((s, i) => `  ${i + 1}. ${i === 0 ? '[→]' : '[ ]'} ${s.subject}  task_id: ${stepIds[i]}`)
        .join('\n') +
      `\n（推进步骤用 task_update，参数 id 取上面的 task_id）`
    )
  },
}

export default tool
