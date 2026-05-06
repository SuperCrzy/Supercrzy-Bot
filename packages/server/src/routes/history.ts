import Router from 'koa-router'
import type { Context } from 'koa'
import { getDB } from '../services/database'

export const historyRouter = new Router({ prefix: '/api/history' })

// List all sessions with messages (read-only)
historyRouter.get('/', (ctx: Context) => {
  const db = getDB()
  const sessions = db.prepare(`
    SELECT s.*, 
      (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as message_count,
      (SELECT content FROM messages WHERE session_id = s.id AND role = 'user' ORDER BY created_at ASC LIMIT 1) as first_msg
    FROM sessions s 
    ORDER BY s.updated_at DESC
  `).all()
  ctx.body = sessions
})

// Get session detail with messages
historyRouter.get('/:id', (ctx: Context) => {
  const db = getDB()
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(ctx.params.id)
  if (!session) { ctx.status = 404; ctx.body = { error: 'Not found' }; return }
  const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(ctx.params.id)
  ctx.body = { session, messages }
})
