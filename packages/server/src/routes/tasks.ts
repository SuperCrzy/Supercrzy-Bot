/**
 * Tasks API 路由 — 任务管理 CRUD + 进度追踪
 */
import Router from 'koa-router'
import { randomUUID } from 'crypto'
import { getDB } from '../services/database.js'

const router = new Router({ prefix: '/api/tasks' })

// 获取所有任务（支持按 session 和 parent 过滤）
router.get('/', (ctx) => {
  const db = getDB()
  const sessionId = ctx.query.session_id as string
  const parentId = ctx.query.parent_id as string
  const status = ctx.query.status as string

  let query = 'SELECT * FROM tasks WHERE 1=1'
  const params: any[] = []

  if (sessionId) {
    query += ' AND session_id = ?'
    params.push(sessionId)
  }
  if (parentId) {
    query += ' AND parent_id = ?'
    params.push(parentId)
  } else if (parentId === '') {
    query += ' AND parent_id IS NULL'
  }
  if (status) {
    query += ' AND status = ?'
    params.push(status)
  }

  query += ' ORDER BY sort_order ASC, created_at DESC'

  const tasks = db.prepare(query).all(...params)
  ctx.body = tasks
})

// 获取单个任务
router.get('/:id', (ctx) => {
  const db = getDB()
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(ctx.params.id)
  if (!task) {
    ctx.status = 404
    ctx.body = { error: 'Task not found' }
    return
  }
  ctx.body = task
})

// 获取子任务
router.get('/:id/children', (ctx) => {
  const db = getDB()
  const children = db.prepare(
    'SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order ASC'
  ).all(ctx.params.id)
  ctx.body = children
})

// 创建任务
router.post('/', (ctx) => {
  const db = getDB()
  const body = ctx.request.body as any

  const id = body.id || randomUUID()
  db.prepare(`
    INSERT INTO tasks (id, session_id, subject, description, status, parent_id, sort_order, blocked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    body.session_id || null,
    body.subject || body.name || 'Untitled',
    body.description || '',
    body.status || 'pending',
    body.parent_id || null,
    body.sort_order || 0,
    body.blocked_by || null,
  )

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  ctx.body = task
  ctx.status = 201
})

// 批量创建任务
router.post('/batch', (ctx) => {
  const db = getDB()
  const { tasks, session_id } = ctx.request.body as { tasks: any[]; session_id?: string }

  if (!Array.isArray(tasks)) {
    ctx.status = 400
    ctx.body = { error: 'tasks must be an array' }
    return
  }

  const results: any[] = []
  const stmt = db.prepare(`
    INSERT INTO tasks (id, session_id, subject, description, status, parent_id, sort_order, blocked_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const t of tasks) {
    const id = t.id || randomUUID()
    stmt.run(
      id,
      session_id || t.session_id || null,
      t.subject || t.name || 'Untitled',
      t.description || '',
      t.status || 'pending',
      t.parent_id || null,
      t.sort_order || 0,
      t.blocked_by || null,
    )
    results.push(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))
  }

  ctx.body = { tasks: results }
  ctx.status = 201
})

// 更新任务
router.patch('/:id', (ctx) => {
  const db = getDB()
  const { status, subject, description, progress, sort_order, blocked_by } = ctx.request.body as any
  const id = ctx.params.id

  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Task not found' }
    return
  }

  const fields: string[] = []
  const values: any[] = []

  if (status !== undefined) { fields.push('status = ?'); values.push(status) }
  if (subject !== undefined) { fields.push('subject = ?'); values.push(subject) }
  if (description !== undefined) { fields.push('description = ?'); values.push(description) }
  if (progress !== undefined) { fields.push('progress = ?'); values.push(Math.max(0, Math.min(100, progress))) }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(sort_order) }
  if (blocked_by !== undefined) { fields.push('blocked_by = ?'); values.push(blocked_by) }

  if (fields.length === 0) {
    ctx.body = existing
    return
  }

  fields.push("updated_at = datetime('now')")
  values.push(id)
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)

  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)

  // 自动重算父任务进度
  if ((updated as any).parent_id) {
    const parentId = (updated as any).parent_id
    const subs = db.prepare(
      "SELECT status FROM tasks WHERE parent_id = ?"
    ).all(parentId) as any[]
    const done = subs.filter((s: any) => s.status === 'completed').length
    const progress = subs.length > 0 ? Math.round((done / subs.length) * 100) : 0
    db.prepare("UPDATE tasks SET progress = ?, updated_at = datetime('now') WHERE id = ?").run(progress, parentId)
  }

  ctx.body = updated
})

// 重算任务进度（从子任务）
router.post('/:id/recalc', (ctx) => {
  const db = getDB()
  const id = ctx.params.id
  const subs = db.prepare(
    "SELECT status FROM tasks WHERE parent_id = ?"
  ).all(id) as any[]
  const done = subs.filter((s: any) => s.status === 'completed').length
  const progress = subs.length > 0 ? Math.round((done / subs.length) * 100) : 0
  db.prepare("UPDATE tasks SET progress = ?, updated_at = datetime('now') WHERE id = ?").run(progress, id)
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  ctx.body = task
})

// 删除任务
router.delete('/:id', (ctx) => {
  const db = getDB()
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(ctx.params.id)
  if (result.changes === 0) {
    ctx.status = 404
    ctx.body = { error: 'Task not found' }
    return
  }
  ctx.body = { success: true }
})

// 获取任务统计
router.get('/stats/summary', (ctx) => {
  const db = getDB()
  const sessionId = ctx.query.session_id as string | undefined

  let where = ''
  const params: any[] = []
  if (sessionId) {
    where = 'WHERE session_id = ?'
    params.push(sessionId)
  }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM tasks ${where}`).get(...params) as any).c
  const pending = (db.prepare(`SELECT COUNT(*) as c FROM tasks ${where}${where ? ' AND' : 'WHERE'} status = 'pending'`).get(...params) as any).c
  const inProgress = (db.prepare(`SELECT COUNT(*) as c FROM tasks ${where}${where ? ' AND' : 'WHERE'} status = 'in_progress'`).get(...params) as any).c
  const completed = (db.prepare(`SELECT COUNT(*) as c FROM tasks ${where}${where ? ' AND' : 'WHERE'} status = 'completed'`).get(...params) as any).c

  ctx.body = { total, pending, in_progress: inProgress, completed }
})

export default router
