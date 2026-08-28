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

// 历史提问：所有 user 消息跨会话列表（DeepSeek 式"历史提问"弹层数据源——每条提问一条记录，按时间倒序，可搜索过滤）
historyRouter.get('/questions', (ctx: Context) => {
  const db = getDB()
  const q = ((ctx.query.q as string) || '').trim()
  const limit = Math.min(parseInt(ctx.query.limit as string, 10) || 100, 500)
  const like = q ? `%${q}%` : null
  const rows = db.prepare(`
    SELECT m.id, m.session_id, m.role, m.content, m.created_at, s.title as session_title
    FROM messages m LEFT JOIN sessions s ON m.session_id = s.id
    WHERE m.role = 'user' AND m.content IS NOT NULL AND m.content != ''
    ${like ? 'AND m.content LIKE ?' : ''}
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(...(like ? [like, limit] : [limit]))
  ctx.body = rows
})

// 全文检索消息（必须先于 /:id 注册，否则 'search' 会被当成 id）
historyRouter.get('/search', (ctx: Context) => {
  const q = ((ctx.query.q as string) || '').trim()
  if (!q) { ctx.body = []; return }
  const db = getDB()
  const like = `%${q}%`
  const rows = db.prepare(`
    SELECT m.id, m.session_id, m.role, m.content, m.created_at, s.title as session_title
    FROM messages m LEFT JOIN sessions s ON m.session_id = s.id
    WHERE m.content LIKE ?
    ORDER BY m.created_at DESC LIMIT 50
  `).all(like)
  ctx.body = rows
})

// Get session detail with messages
historyRouter.get('/:id', (ctx: Context) => {
  const db = getDB()
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(ctx.params.id)
  if (!session) { ctx.status = 404; ctx.body = { error: 'Not found' }; return }
  const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(ctx.params.id)
  ctx.body = { session, messages }
})
