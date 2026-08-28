/**
 * Automations API — 定时自动化任务管理
 */
import Router from 'koa-router'
import { randomUUID } from 'crypto'
import { getDB } from '../services/database.js'

const router = new Router({ prefix: '/api/automations' })

// Simple RRULE parser (supports DAILY/WEEKLY/MONTHLY + time)
function parseRrule(rrule: string): { freq: string; time?: string; byday?: string[] } | null {
  if (!rrule) return null
  const parts = rrule.split(';').reduce((acc: Record<string, string>, p) => {
    const [k, ...v] = p.split('=')
    acc[k.trim().toUpperCase()] = v.join('=').trim()
    return acc
  }, {})
  return {
    freq: parts.FREQ || '',
    time: parts.BYTIME || parts.UNTIL?.match(/\d{4}/) ? undefined : undefined,
    byday: parts.BYDAY?.split(',') || [],
  }
}

// Calculate next run time from RRULE
function calcNextRun(rrule: string, fromTime?: number): number {
  if (!rrule) return 0
  const now = fromTime ? new Date(fromTime) : new Date()
  const parsed = parseRrule(rrule)
  if (!parsed) return 0

  // Extract time from RRULE if present (e.g., T090000)
  const timeMatch = rrule.match(/T(\d{2})(\d{2})(\d{2})/)
  const hour = timeMatch ? parseInt(timeMatch[1]) : 9
  const minute = timeMatch ? parseInt(timeMatch[2]) : 0

  // Set target time today
  let next = new Date(now)
  next.setHours(hour, minute, 0, 0)

  // If time already passed, advance
  if (next.getTime() <= now.getTime()) {
    switch (parsed.freq) {
      case 'HOURLY':
        next.setHours(next.getHours() + 1)
        break
      case 'DAILY':
        next.setDate(next.getDate() + 1)
        break
      case 'WEEKLY': {
        const weekdays = parsed.byday?.map(d => ['MO','TU','WE','TH','FR','SA','SU'].indexOf(d) + 1).filter(n => n > 0)
        if (weekdays && weekdays.length > 0) {
          const today = now.getDay() || 7
          const nextDay = weekdays.find(d => d > today) || weekdays[0]
          const daysToAdd = nextDay > today ? nextDay - today : 7 - today + nextDay
          next.setDate(next.getDate() + daysToAdd)
        } else {
          next.setDate(next.getDate() + 7)
        }
        break
      }
      case 'MONTHLY':
        next.setMonth(next.getMonth() + 1)
        break
      default:
        next.setDate(next.getDate() + 1)
    }
  }

  return next.getTime()
}

// 获取所有自动化
router.get('/', (ctx) => {
  const db = getDB()
  const status = ctx.query.status as string
  let query = 'SELECT * FROM automations ORDER BY created_at DESC'
  if (status) {
    query = 'SELECT * FROM automations WHERE status = ? ORDER BY created_at DESC'
    ctx.body = db.prepare(query).all(status)
    return
  }
  ctx.body = db.prepare(query).all()
})

// 创建自动化
router.post('/', (ctx) => {
  const db = getDB()
  const body = ctx.request.body as any

  // 必填校验：缺 name/prompt 返回 400（而不是落库 500）
  if (!body.name || !String(body.name).trim()) {
    ctx.status = 400
    ctx.body = { error: 'name is required' }
    return
  }
  if (!body.prompt || !String(body.prompt).trim()) {
    ctx.status = 400
    ctx.body = { error: 'prompt is required' }
    return
  }

  const id = body.id || randomUUID()
  const now = Math.floor(Date.now() / 1000)

  const rrule = body.rrule || ''
  const scheduledAt = body.scheduled_at || body.scheduledAt || null
  const notifyChannel = body.notify_channel || ''
  const eventTrigger = body.event_trigger || ''
  const nextRunAt = scheduledAt
    ? Math.floor(new Date(scheduledAt).getTime() / 1000)
    : body.schedule_type !== 'once' ? Math.floor(calcNextRun(rrule) / 1000) : 0

  db.prepare(`
    INSERT INTO automations (id, name, prompt, status, schedule_type, rrule, scheduled_at, next_run_at, model_id, event_trigger, notify_channel, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, body.name, body.prompt, body.status || 'active', body.schedule_type || 'recurring', rrule, scheduledAt, nextRunAt, body.model_id || null, eventTrigger, notifyChannel, now, now)

  const created = db.prepare('SELECT * FROM automations WHERE id = ?').get(id)
  ctx.body = created
  ctx.status = 201
})

// 更新自动化
router.patch('/:id', (ctx) => {
  const db = getDB()
  const body = ctx.request.body as any
  const now = Math.floor(Date.now() / 1000)

  const existing = db.prepare('SELECT * FROM automations WHERE id = ?').get(ctx.params.id) as any
  if (!existing) { ctx.status = 404; ctx.body = { error: 'Not found' }; return }

  const fields: string[] = []
  const values: any[] = []
  const simpleFields = ['name', 'prompt', 'status', 'schedule_type', 'rrule', 'scheduled_at', 'model_id', 'notify_channel', 'event_trigger']

  for (const f of simpleFields) {
    if (body[f] !== undefined) { fields.push(`${f} = ?`); values.push(body[f]) }
  }

  // Recalc next run if schedule changed
  if (body.rrule || body.scheduled_at) {
    const rrule = body.rrule || existing.rrule
    const nextRunAt = body.scheduled_at
      ? Math.floor(new Date(body.scheduled_at).getTime() / 1000)
      : Math.floor(calcNextRun(rrule) / 1000)
    fields.push('next_run_at = ?')
    values.push(nextRunAt)
  }

  if (fields.length > 0) {
    fields.push('updated_at = ?')
    values.push(now)
    values.push(ctx.params.id)
    db.prepare(`UPDATE automations SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  ctx.body = db.prepare('SELECT * FROM automations WHERE id = ?').get(ctx.params.id)
})

// 删除自动化
router.delete('/:id', (ctx) => {
  const result = getDB().prepare('DELETE FROM automations WHERE id = ?').run(ctx.params.id)
  if (result.changes === 0) { ctx.status = 404; ctx.body = { error: 'Not found' }; return }
  ctx.body = { success: true }
})

// 手动触发
router.post('/:id/trigger', (ctx) => {
  const db = getDB()
  const auto = db.prepare('SELECT * FROM automations WHERE id = ?').get(ctx.params.id) as any
  if (!auto) { ctx.status = 404; ctx.body = { error: 'Not found' }; return }

  // Update last run time
  const now = Math.floor(Date.now() / 1000)
  db.prepare('UPDATE automations SET last_run_at = ?, next_run_at = ? WHERE id = ?').run(
    now, auto.schedule_type !== 'once' ? Math.floor(calcNextRun(auto.rrule, Date.now()) / 1000) : 0, ctx.params.id
  )

  ctx.body = { success: true, prompt: auto.prompt, id: auto.id }
})

// 事件触发：模拟事件（file-changed / message-received / manual），匹配的自动化立即执行
router.post('/event', async (ctx) => {
  const { event, context } = (ctx.request.body as any) || {}
  if (!event || typeof event !== 'string') {
    ctx.status = 400
    ctx.body = { error: 'event is required (file-changed | message-received | manual)' }
    return
  }
  const { fireAutomationForEvent } = await import('../services/scheduler')
  const fired = await fireAutomationForEvent(event, typeof context === 'string' ? context : undefined)
  ctx.body = { success: true, fired }
})

export { calcNextRun }
export default router
