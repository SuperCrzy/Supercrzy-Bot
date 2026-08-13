/**
 * Roles API — 专家角色管理
 * 角色由 database.ts seed 内置（设计/开发/数据分析/文案/通用），本路由提供查看/更新
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { getDB } from '../services/database'
import { invalidateRolesCache } from '../services/role-router'

export const rolesRouter = new Router({ prefix: '/api/roles' })

// 列表（按 sort_order）
rolesRouter.get('/', (ctx: Context) => {
  const db = getDB()
  const rows = db.prepare(
    'SELECT id, name, task_keywords, system_prompt, enabled, is_default, sort_order FROM roles ORDER BY sort_order ASC'
  ).all() as any[]
  ctx.body = rows.map((r) => ({
    id: r.id,
    name: r.name,
    taskKeywords: r.task_keywords,
    systemPrompt: r.system_prompt,
    enabled: !!r.enabled,
    isDefault: !!r.is_default,
    sortOrder: r.sort_order,
  }))
})

// 更新角色
rolesRouter.put('/:id', (ctx: Context) => {
  const db = getDB()
  const { id } = ctx.params
  const body = ctx.request.body as any

  const sets: string[] = []
  const vals: any[] = []

  if (body.name !== undefined) { sets.push('name=?'); vals.push(body.name) }
  if (body.taskKeywords !== undefined) { sets.push('task_keywords=?'); vals.push(body.taskKeywords) }
  if (body.systemPrompt !== undefined) { sets.push('system_prompt=?'); vals.push(body.systemPrompt) }
  if (body.enabled !== undefined) { sets.push('enabled=?'); vals.push(body.enabled ? 1 : 0) }

  if (sets.length === 0) { ctx.body = { success: true }; return }
  sets.push("updated_at=datetime('now')"); vals.push(id)
  const result = db.prepare(`UPDATE roles SET ${sets.join(',')} WHERE id=?`).run(...vals)

  if (result.changes === 0) {
    ctx.status = 404
    ctx.body = { error: 'Role not found' }
    return
  }
  invalidateRolesCache() // 角色变更后刷新内存缓存
  ctx.body = { success: true }
})

// 重置为默认角色（删除自定义改动，重新 seed）
rolesRouter.post('/reset', (ctx: Context) => {
  const db = getDB()
  // 删除所有非默认 seed 的角色，交由下次启动重新 seed（或直接重建默认）
  db.prepare("DELETE FROM roles WHERE id NOT IN ('role-design','role-dev','role-data','role-copy','role-general')").run()
  invalidateRolesCache()
  ctx.body = { success: true }
})
