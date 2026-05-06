import Router from 'koa-router'
import type { Context } from 'koa'
import { getDB } from '../services/database'

export const statsRouter = new Router({ prefix: '/api/stats' })

// Get usage statistics
statsRouter.get('/usage', (ctx: Context) => {
  const db = getDB()
  const totalSessions = (db.prepare('SELECT COUNT(*) as count FROM sessions').get() as any).count
  const totalMessages = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as any).count
  const totalTokens = (db.prepare('SELECT SUM(token_count) as total FROM messages').get() as any).total || 0
  const totalCost = (db.prepare('SELECT SUM(cost) as total FROM messages').get() as any).total || 0
  const today = new Date().toISOString().slice(0, 10)
  const todayMessages = (db.prepare("SELECT COUNT(*) as count FROM messages WHERE date(created_at) = ?").get(today) as any).count
  const todayTokens = (db.prepare("SELECT SUM(token_count) as total FROM messages WHERE date(created_at) = ?").get(today) as any).total || 0
  const todayCost = (db.prepare("SELECT SUM(cost) as total FROM messages WHERE date(created_at) = ?").get(today) as any).total || 0

  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7)
  const weeklyUsage = db.prepare(
    "SELECT date(created_at) as date, COUNT(*) as messages, SUM(token_count) as tokens FROM messages WHERE created_at >= ? GROUP BY date(created_at) ORDER BY date"
  ).all(weekStart.toISOString().slice(0, 10))

  ctx.body = {
    total: { sessions: totalSessions, messages: totalMessages, tokens: totalTokens, cost: totalCost },
    today: { messages: todayMessages, tokens: todayTokens, cost: todayCost },
    weekly: weeklyUsage,
  }
})

// Get recent logs (from database operations)
statsRouter.get('/logs', (ctx: Context) => {
  const db = getDB()
  const recent = db.prepare(`
    SELECT m.role, m.content, m.created_at, m.token_count, s.title as session_title
    FROM messages m LEFT JOIN sessions s ON m.session_id = s.id
    ORDER BY m.created_at DESC LIMIT 50
  `).all()
  ctx.body = recent
})
