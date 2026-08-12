/**
 * Playbook API — Agent 经验库
 * 复盘由 agent.ts 任务完成后自动生成，本路由提供查看/删除
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { getDB } from '../services/database'

export const playbookRouter = new Router({ prefix: '/api/playbook' })

// 列表（按时间倒序）
playbookRouter.get('/', (ctx: Context) => {
  const db = getDB()
  const rows = db.prepare(
    'SELECT id, task_type, lesson, tools_used, turns, tool_calls, outcome, confidence, created_at FROM playbook ORDER BY created_at DESC LIMIT 100'
  ).all() as any[]
  ctx.body = rows.map((r) => ({
    id: r.id,
    taskType: r.task_type,
    lesson: r.lesson,
    toolsUsed: JSON.parse(r.tools_used || '[]'),
    turns: r.turns,
    toolCalls: r.tool_calls,
    outcome: r.outcome,
    confidence: r.confidence,
    createdAt: r.created_at,
  }))
})

// 删除
playbookRouter.delete('/:id', (ctx: Context) => {
  const db = getDB()
  const result = db.prepare('DELETE FROM playbook WHERE id = ?').run(ctx.params.id)
  if (result.changes === 0) {
    ctx.status = 404
    ctx.body = { error: 'Playbook entry not found' }
    return
  }
  ctx.body = { success: true }
})

export default playbookRouter
