import Router from 'koa-router'
import type { Context } from 'koa'
import { getDB } from '../services/database'
import { getBalance, LOW_BALANCE_THRESHOLD_CNY } from '../services/balance'

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

  // 估算占比：token_estimated=1 的 token 数是前端按字符推算的，不是模型返回的真值
  const estimateAgg = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN token_estimated = 1 THEN token_count ELSE 0 END), 0) as estimated,
           COALESCE(SUM(CASE WHEN token_estimated = 0 THEN token_count ELSE 0 END), 0) as measured,
           COALESCE(SUM(CASE WHEN token_estimated = 1 THEN 1 ELSE 0 END), 0) as estimated_messages,
           COUNT(token_count) as tokenized_messages
    FROM messages
  `).get() as any
  const estimatedTokens = estimateAgg.estimated || 0
  const measuredTokens = estimateAgg.measured || 0
  const estimatedShare = totalTokens > 0 ? Math.round((estimatedTokens / totalTokens) * 1000) / 1000 : 0

  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 7)
  const weeklyUsage = db.prepare(
    "SELECT date(created_at) as date, COUNT(*) as messages, SUM(token_count) as tokens, SUM(CASE WHEN token_estimated = 1 THEN 1 ELSE 0 END) as estimated_messages FROM messages WHERE created_at >= ? GROUP BY date(created_at) ORDER BY date"
  ).all(weekStart.toISOString().slice(0, 10))

  // 按模型分组统计（2026-10-22 修归属错配）
  // 旧实现 `GROUP BY s.model` 用的是**建会话那一刻**的模型：在设置页换了模型之后，
  // 新消息依然挂在老模型名下 —— 实测「模型是 deepseek-v4-flash，用量页却写 deepseek-v4-pro」。
  // 现在优先读 m.model（agent.ts 每轮 usage 下发、随消息落库的真实模型），
  // 只有迁移前的老消息（m.model 为 NULL/''）才回退到 s.model，并单独计数供 UI 标注。
  const byModel = db.prepare(`
    SELECT COALESCE(NULLIF(m.model, ''), s.model) as model,
           COUNT(m.id) as count,
           COALESCE(SUM(m.token_count), 0) as tokens,
           COALESCE(SUM(CASE WHEN m.token_estimated = 1 THEN m.token_count ELSE 0 END), 0) as estimated_tokens,
           COALESCE(SUM(CASE WHEN m.model IS NULL OR m.model = '' THEN 1 ELSE 0 END), 0) as unattributed,
           COALESCE(SUM(m.cost), 0) as cost,
           MAX(m.created_at) as last_used
    FROM messages m JOIN sessions s ON m.session_id = s.id
    GROUP BY COALESCE(NULLIF(m.model, ''), s.model) ORDER BY count DESC
  `).all()

  // 归因不可靠的消息数（迁移前老数据：messages.model 为空，只能借 sessions.model 顶包）
  const unattributedMessages = (byModel as Array<any>).reduce((sum, r) => sum + (r.unattributed || 0), 0)

  ctx.body = {
    total: {
      sessions: totalSessions,
      messages: totalMessages,
      tokens: totalTokens,
      cost: totalCost,
      // token 数据可信度：measuredTokens 来自模型 usage，estimatedTokens 是字符×0.6 推算
      measuredTokens,
      estimatedTokens,
      estimatedShare,
      estimatedMessages: estimateAgg.estimated_messages || 0,
      tokenizedMessages: estimateAgg.tokenized_messages || 0,
      /** 模型归属不可靠的消息数（老数据，没有逐条 model） */
      unattributedMessages,
    },
    today: { messages: todayMessages, tokens: todayTokens, cost: todayCost },
    weekly: weeklyUsage,
    byModel,
  }
})

// API 余额（DeepSeek 官方 /user/balance 的服务端代理）
// key 不出服务端；前端只拿汇总数字。?force=1 跳过 5 分钟缓存（设置页「刷新」用）。
statsRouter.get('/balance', async (ctx: Context) => {
  const force = String((ctx.query as any)?.force || '') === '1'
  try {
    ctx.body = await getBalance({ force })
  } catch (err: any) {
    // 展示性问题不许把整页打成 500
    ctx.body = {
      supported: false,
      provider: 'other',
      isAvailable: false,
      balances: [],
      fetchedAt: new Date().toISOString(),
      thresholdCny: LOW_BALANCE_THRESHOLD_CNY,
      low: false,
      note: `余额查询失败：${err?.message || err}`,
    }
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
