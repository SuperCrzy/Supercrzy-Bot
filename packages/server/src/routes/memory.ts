import Router from 'koa-router'
import type { Context } from 'koa'
import { getDB } from '../services/database'
import { randomUUID } from 'crypto'

export const memoryRouter = new Router({ prefix: '/api/memory' })

// List all memories
memoryRouter.get('/', (ctx: Context) => {
  const db = getDB()
  const { category, search } = ctx.query

  let sql = 'SELECT * FROM agent_memory'
  const params: string[] = []
  const conditions: string[] = []

  if (category && category !== 'all') {
    conditions.push('category = ?')
    params.push(category as string)
  }
  if (search) {
    conditions.push('(key LIKE ? OR content LIKE ?)')
    params.push(`%${search}%`, `%${search}%`)
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ')
  }
  sql += ' ORDER BY updated_at DESC'

  const rows = db.prepare(sql).all(...params)
  ctx.body = rows
})

// Get single memory
memoryRouter.get('/:id', (ctx: Context) => {
  const db = getDB()
  const row = db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(ctx.params.id)
  if (!row) {
    ctx.status = 404
    ctx.body = { error: 'Memory not found' }
    return
  }
  ctx.body = row
})

// Create memory
memoryRouter.post('/', (ctx: Context) => {
  const db = getDB()
  const body = ctx.request.body as { key: string; content: string; category?: string; importance?: number }

  if (!body.key || !body.content) {
    ctx.status = 400
    ctx.body = { error: 'key and content are required' }
    return
  }

  const id = randomUUID()
  const category = body.category || 'general'
  const importance = body.importance || 1

  db.prepare(
    'INSERT INTO agent_memory (id, key, content, category, importance) VALUES (?, ?, ?, ?, ?)'
  ).run(id, body.key, body.content, category, importance)

  const row = db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(id)
  ctx.status = 201
  ctx.body = row
})

// Update memory
memoryRouter.put('/:id', (ctx: Context) => {
  const db = getDB()
  const body = ctx.request.body as { key?: string; content?: string; category?: string; importance?: number }

  const existing = db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(ctx.params.id)
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Memory not found' }
    return
  }

  const updates: string[] = []
  const params: any[] = []

  if (body.key !== undefined) { updates.push('key = ?'); params.push(body.key) }
  if (body.content !== undefined) { updates.push('content = ?'); params.push(body.content) }
  if (body.category !== undefined) { updates.push('category = ?'); params.push(body.category) }
  if (body.importance !== undefined) { updates.push('importance = ?'); params.push(body.importance) }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')")
    params.push(ctx.params.id)
    db.prepare(`UPDATE agent_memory SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  }

  const row = db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(ctx.params.id)
  ctx.body = row
})

// Delete memory
memoryRouter.delete('/:id', (ctx: Context) => {
  const db = getDB()
  const result = db.prepare('DELETE FROM agent_memory WHERE id = ?').run(ctx.params.id)
  if (result.changes === 0) {
    ctx.status = 404
    ctx.body = { error: 'Memory not found' }
    return
  }
  ctx.body = { success: true }
})

// Search memories by keyword
memoryRouter.post('/search', (ctx: Context) => {
  const db = getDB()
  const body = ctx.request.body as { query: string; limit?: number }

  if (!body.query) {
    ctx.status = 400
    ctx.body = { error: 'query is required' }
    return
  }

  const limit = body.limit || 10
  const rows = db.prepare(
    `SELECT * FROM agent_memory
     WHERE key LIKE ? OR content LIKE ?
     ORDER BY importance DESC, updated_at DESC
     LIMIT ?`
  ).all(`%${body.query}%`, `%${body.query}%`, limit)

  ctx.body = rows
})
