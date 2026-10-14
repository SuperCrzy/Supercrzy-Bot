/**
 * 例程（Routine）API — 把跑通的任务保存为可复用流程，一键重放（"演示一次就学会"）
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { randomUUID } from 'crypto'
import { getDB } from '../services/database.js'

export const routineRouter = new Router({ prefix: '/api/routines' })

/** 列表 */
routineRouter.get('/', (ctx: Context) => {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM routines ORDER BY updated_at DESC').all() as any[]
  ctx.body = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    steps: safeJson(r.steps, []),
    sourceSessionId: r.source_session_id,
    runCount: r.run_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
})

/** 从会话生成例程：汇总该会话的用户任务 + 助手要点为描述 */
routineRouter.post('/from-session', (ctx: Context) => {
  const db = getDB()
  const { sessionId, name } = (ctx.request.body || {}) as { sessionId?: string; name?: string }
  if (!sessionId) {
    ctx.status = 400
    ctx.body = { error: 'sessionId 必填' }
    return
  }
  const msgs = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as any[]
  const userTasks: string[] = []
  const assistantSummary: string[] = []
  for (const m of msgs) {
    if (m.role === 'user' && m.content && typeof m.content === 'string' && m.content.trim()) {
      userTasks.push(m.content.trim().slice(0, 200))
    }
    if (m.role === 'assistant' && m.content && typeof m.content === 'string') {
      const text = m.content.replace(/<[^>]+>/g, '').trim()
      if (text && text.length > 20) assistantSummary.push(text.slice(0, 300))
    }
  }
  if (userTasks.length === 0 && assistantSummary.length === 0) {
    ctx.status = 400
    ctx.body = { error: '会话没有可保存的内容' }
    return
  }
  const id = randomUUID()
  const finalName = (name || '').trim() || (userTasks[0] || '未命名例程').slice(0, 40)
  const description = [
    userTasks.length ? `任务目标：${userTasks[0]}` : '',
    assistantSummary.length ? `执行要点：\n${assistantSummary.slice(0, 3).join('\n')}` : '',
  ].filter(Boolean).join('\n\n')
  db.prepare(
    'INSERT INTO routines (id, name, description, source_session_id) VALUES (?, ?, ?, ?)'
  ).run(id, finalName, description.slice(0, 3000), sessionId)
  ctx.status = 201
  ctx.body = { success: true, id, name: finalName }
})

/** 新建（手动） */
routineRouter.post('/', (ctx: Context) => {
  const db = getDB()
  const body = (ctx.request.body || {}) as { name?: string; description?: string; steps?: Array<{ tool: string; note: string }> }
  const name = (body.name || '').trim()
  if (!name) {
    ctx.status = 400
    ctx.body = { error: '名称必填' }
    return
  }
  const id = randomUUID()
  db.prepare(
    'INSERT INTO routines (id, name, description, steps) VALUES (?, ?, ?, ?)'
  ).run(id, name, (body.description || '').trim(), JSON.stringify(body.steps || []))
  ctx.status = 201
  ctx.body = { success: true, id }
})

/** 更新 */
routineRouter.put('/:id', (ctx: Context) => {
  const db = getDB()
  const existing = db.prepare('SELECT * FROM routines WHERE id = ?').get(ctx.params.id) as any
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Not found' }
    return
  }
  const body = (ctx.request.body || {}) as Record<string, any>
  const fields: string[] = []
  const values: any[] = []
  for (const key of ['name', 'description']) {
    if (body[key] !== undefined) {
      fields.push(`${key} = ?`)
      values.push(String(body[key]).trim())
    }
  }
  if (body.steps !== undefined) {
    fields.push('steps = ?')
    values.push(typeof body.steps === 'string' ? body.steps : JSON.stringify(body.steps))
  }
  if (fields.length > 0) {
    fields.push("updated_at = datetime('now')")
    values.push(ctx.params.id)
    db.prepare(`UPDATE routines SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }
  ctx.body = { success: true }
})

/** 删除 */
routineRouter.delete('/:id', (ctx: Context) => {
  const db = getDB()
  const result = db.prepare('DELETE FROM routines WHERE id = ?').run(ctx.params.id)
  if (result.changes === 0) {
    ctx.status = 404
    ctx.body = { error: 'Not found' }
    return
  }
  ctx.body = { success: true }
})

/** 执行：run_count +1（前端随后把例程描述作为指令发出） */
routineRouter.post('/:id/run', (ctx: Context) => {
  const db = getDB()
  db.prepare("UPDATE routines SET run_count = run_count + 1, updated_at = datetime('now') WHERE id = ?").run(ctx.params.id)
  ctx.body = { success: true }
})

function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try { return JSON.parse(s) } catch { return fallback }
}
