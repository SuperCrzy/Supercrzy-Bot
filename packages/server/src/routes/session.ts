import Router from 'koa-router'
import type { Context } from 'koa'
import { v4 as uuidv4 } from 'uuid'
import { getDB } from '../services/database'

export const sessionRouter = new Router({ prefix: '/api/sessions' })

// List sessions
sessionRouter.get('/', (ctx: Context) => {
  const db = getDB()
  const sessions = db
    .prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
    .all() as Array<any>
  ctx.body = sessions
})

// Get session with messages
sessionRouter.get('/:id', (ctx: Context) => {
  const db = getDB()
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(ctx.params.id) as any
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  const messages = db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(ctx.params.id) as Array<any>
  // Parse attachments JSON for each message
  for (const msg of messages) {
    if (msg.attachments) {
      try {
        msg.attachments = JSON.parse(msg.attachments)
      } catch {
        msg.attachments = []
      }
    } else {
      msg.attachments = []
    }
  }
  ctx.body = { ...session, messages }
})

// Create session
sessionRouter.post('/', (ctx: Context) => {
  const db = getDB()
  const body = ctx.request.body as { id?: string; title?: string; model?: string }
  // 接受前端传入的 ID，没有则自动生成
  const id = body.id || uuidv4()
  db.prepare('INSERT INTO sessions (id, title, model) VALUES (?, ?, ?)').run(
    id,
    body.title || 'New Chat',
    body.model || 'deepseek-v4-pro'
  )
  ctx.body = { id, title: body.title || 'New Chat', model: body.model || 'deepseek-v4-pro' }
  ctx.status = 201
})

// Delete session
sessionRouter.delete('/:id', (ctx: Context) => {
  const db = getDB()
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(ctx.params.id)
  if (result.changes === 0) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  ctx.body = { success: true }
})

// Add message to session (幂等：用 INSERT OR REPLACE 支持重复调用)
sessionRouter.post('/:id/messages', (ctx: Context) => {
  const db = getDB()
  const body = ctx.request.body as {
    id?: string
    role: string
    content: string
    token_count?: number
    cost?: number
    attachments?: Array<{ id: string; name: string; type: string; size: number; url: string; thumbnailUrl?: string }>
  }

  if (!body.role || body.content === undefined) {
    ctx.status = 400
    ctx.body = { error: 'role and content are required' }
    return
  }

  const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }

  // 接受前端传入的 ID，没有则自动生成
  const id = body.id || uuidv4()
  const attachmentsJson = body.attachments ? JSON.stringify(body.attachments) : null

  // 检查消息是否已存在（幂等）
  const existing = db.prepare('SELECT id FROM messages WHERE id = ?').get(id)
  if (existing) {
    // 更新已有消息内容
    db.prepare(
      'UPDATE messages SET content = ?, token_count = ?, cost = ?, attachments = ?, created_at = datetime(\'now\') WHERE id = ?'
    ).run(body.content, body.token_count || null, body.cost || null, attachmentsJson, id)
  } else {
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, token_count, cost, attachments) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, ctx.params.id, body.role, body.content, body.token_count || null, body.cost || null, attachmentsJson)
  }

  // Update session timestamp
  db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(ctx.params.id)

  ctx.body = { id, ...body }
  ctx.status = 201
})
