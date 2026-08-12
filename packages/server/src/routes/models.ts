import Router from 'koa-router'
import type { Context } from 'koa'
import { randomUUID } from 'crypto'
import { getDB } from '../services/database'

export const modelsRouter = new Router({ prefix: '/api/models' })

// ========================
// Providers
// ========================

/** GET /api/models/providers — 列出所有提供商（预设+自定义） */
modelsRouter.get('/providers', (ctx: Context) => {
  const db = getDB()
  const rows = db.prepare(
    'SELECT id, name, provider_key, base_url, api_key, models, capabilities, enabled, is_preset, sort_order FROM custom_providers ORDER BY sort_order'
  ).all() as any[]

  const providers = rows.map((r: any) => ({
    id: r.id,
    name: r.name,
    providerKey: r.provider_key,
    baseUrl: r.base_url,
    apiKey: r.api_key ? r.api_key.slice(0, 8) + '...' + r.api_key.slice(-4) : '',
    hasApiKey: !!r.api_key,
    models: safeJson(r.models),
    capabilities: safeJson(r.capabilities),
    enabled: !!r.enabled,
    isPreset: !!r.is_preset,
    sortOrder: r.sort_order,
  }))
  ctx.body = providers
})

/** PUT /api/models/providers/:id — 更新提供商配置（设置 API Key / 启用禁用） */
modelsRouter.put('/providers/:id', (ctx: Context) => {
  try {
    const db = getDB()
    const { id } = ctx.params
    const body = ctx.request.body as Record<string, any>

    const provider = db.prepare('SELECT * FROM custom_providers WHERE id = ?').get(id) as any
    if (!provider) {
      ctx.status = 404
      ctx.body = { error: 'Provider not found' }
      return
    }

    const updates: string[] = []
    const values: any[] = []

    if (body.apiKey !== undefined) {
      updates.push('api_key = ?')
      values.push(String(body.apiKey))
    }
    if (body.baseUrl !== undefined) {
      updates.push('base_url = ?')
      values.push(String(body.baseUrl))
    }
    if (body.models !== undefined) {
      updates.push('models = ?')
      values.push(JSON.stringify(body.models))
    }
    if (body.enabled !== undefined) {
      updates.push('enabled = ?')
      values.push(body.enabled ? 1 : 0)
    }

    if (updates.length === 0) {
      ctx.status = 400
      ctx.body = { error: 'No fields to update' }
      return
    }

    updates.push("updated_at = datetime('now')")
    values.push(id)

    db.prepare(`UPDATE custom_providers SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// ========================
// Custom Models
// ========================

/** GET /api/models/custom — 列出所有自定义模型 */
modelsRouter.get('/custom', (ctx: Context) => {
  const db = getDB()
  const rows = db.prepare(`
    SELECT cm.*, cp.name AS provider_name, cp.provider_key, cp.base_url, cp.api_key
    FROM custom_models cm
    JOIN custom_providers cp ON cm.provider_id = cp.id
    ORDER BY cm.created_at DESC
  `).all() as any[]

  const models = rows.map((r: any) => ({
    id: r.id,
    providerId: r.provider_id,
    providerName: r.provider_name,
    providerKey: r.provider_key,
    modelId: r.model_id,
    displayName: r.display_name || r.model_id,
    baseUrl: r.base_url,
    hasApiKey: !!r.api_key,
    enabled: !!r.enabled,
    isDefault: !!r.is_default,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }))
  ctx.body = models
})

/** POST /api/models/custom — 添加自定义模型 */
modelsRouter.post('/custom', (ctx: Context) => {
  try {
    const db = getDB()
    const body = ctx.request.body as Record<string, any>

    if (!body.providerId || !body.modelId) {
      ctx.status = 400
      ctx.body = { error: 'providerId and modelId are required' }
      return
    }

    const provider = db.prepare('SELECT * FROM custom_providers WHERE id = ?').get(body.providerId) as any
    if (!provider) {
      ctx.status = 404
      ctx.body = { error: 'Provider not found' }
      return
    }

    const id = randomUUID()
    db.prepare(`
      INSERT INTO custom_models (id, provider_id, model_id, display_name, enabled, is_default)
      VALUES (?, ?, ?, ?, 1, 0)
    `).run(id, body.providerId, body.modelId, body.displayName || body.modelId)

    ctx.body = {
      success: true,
      model: {
        id,
        providerId: body.providerId,
        modelId: body.modelId,
        displayName: body.displayName || body.modelId,
        providerName: provider.name,
        providerKey: provider.provider_key,
        enabled: true,
      },
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

/** PUT /api/models/custom/:id — 更新自定义模型 */
modelsRouter.put('/custom/:id', (ctx: Context) => {
  try {
    const db = getDB()
    const { id } = ctx.params
    const body = ctx.request.body as Record<string, any>

    const existing = db.prepare('SELECT * FROM custom_models WHERE id = ?').get(id) as any
    if (!existing) {
      ctx.status = 404
      ctx.body = { error: 'Model not found' }
      return
    }

    const updates: string[] = []
    const values: any[] = []

    if (body.displayName !== undefined) {
      updates.push('display_name = ?')
      values.push(String(body.displayName))
    }
    if (body.enabled !== undefined) {
      updates.push('enabled = ?')
      values.push(body.enabled ? 1 : 0)
    }
    if (body.isDefault !== undefined) {
      updates.push('is_default = ?')
      values.push(body.isDefault ? 1 : 0)
    }
    if (body.modelId !== undefined) {
      updates.push('model_id = ?')
      values.push(String(body.modelId))
    }

    if (updates.length === 0) {
      ctx.status = 400
      ctx.body = { error: 'No fields to update' }
      return
    }

    updates.push("updated_at = datetime('now')")
    values.push(id)

    db.prepare(`UPDATE custom_models SET ${updates.join(', ')} WHERE id = ?`).run(...values)
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

/** DELETE /api/models/custom/:id — 删除自定义模型 */
modelsRouter.delete('/custom/:id', (ctx: Context) => {
  try {
    const db = getDB()
    const { id } = ctx.params

    const result = db.prepare('DELETE FROM custom_models WHERE id = ?').run(id)
    if (result.changes === 0) {
      ctx.status = 404
      ctx.body = { error: 'Model not found' }
      return
    }
    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// ========================
// Utilities
// ========================

function safeJson(val: string): any[] {
  try { return JSON.parse(val) } catch { return [] }
}
