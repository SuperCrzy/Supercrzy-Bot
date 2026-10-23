/**
 * 闲置能力建议 API（G3，2026-10-23）。
 *
 * GET  /api/capabilities/idle          → 当前建议（按闲置天数倒序）
 * POST /api/capabilities/idle/dismiss  → { tool } 记住"本版本不再推"（版本 = capabilityVersion）
 *
 * 用量口径 = playbook.tools_used（与 G3 现状证据同一口径，2026-09-24 实测）。
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { getDB } from '../services/database'
import { toolDefinitions } from '../services/tools'
import { computeIdleSuggestions, capabilityVersion, type DismissRecord } from '../services/idle-capability'

export const capabilitiesRouter = new Router({ prefix: '/api/capabilities' })

const DISMISS_KEY = 'idleCapabilityDismissed'

function todayISO(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

function loadDismissed(db: ReturnType<typeof getDB>): DismissRecord[] {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(DISMISS_KEY) as any
    const parsed = row?.value ? JSON.parse(row.value) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

capabilitiesRouter.get('/idle', (ctx: Context) => {
  const db = getDB()
  const rows = db.prepare('SELECT tools_used, created_at FROM playbook ORDER BY created_at ASC').all() as any[]
  const usage = rows.map((r) => {
    let tools: string[] = []
    try { tools = JSON.parse(r.tools_used || '[]') } catch { /* 坏行跳过 */ }
    return { toolsUsed: Array.isArray(tools) ? tools : [], date: String(r.created_at || '').slice(0, 10) }
  }).filter((u) => /^\d{4}-\d{2}-\d{2}$/.test(u.date))

  const catalog = toolDefinitions.map((t) => ({ name: t.name, description: t.description }))
  const version = capabilityVersion(catalog)
  const { suggestions, idleDays } = computeIdleSuggestions({
    today: todayISO(),
    catalog,
    usage,
    dismissed: loadDismissed(db),
    version,
  })
  ctx.body = { version, suggestions, idleDays }
})

capabilitiesRouter.post('/idle/dismiss', (ctx: Context) => {
  const tool = String((ctx.request.body as any)?.tool || '')
  if (!tool) {
    ctx.status = 400
    ctx.body = { error: 'tool required' }
    return
  }
  const db = getDB()
  const catalog = toolDefinitions.map((t) => ({ name: t.name, description: t.description }))
  const version = capabilityVersion(catalog)
  const dismissed = loadDismissed(db).filter((d) => d.tool !== tool)
  dismissed.push({ tool, version })
  // 上限 200 条防膨胀（注册表总共 43 个，正常远小于此）
  const trimmed = dismissed.slice(-200)
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(DISMISS_KEY, JSON.stringify(trimmed))
  ctx.body = { success: true, tool, version }
})

export default capabilitiesRouter
