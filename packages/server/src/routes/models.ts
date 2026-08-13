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

    // 兼容两种 id 语义：custom_providers.id（preset-xxx）或 provider_key（deepseek）
    let provider = db.prepare('SELECT * FROM custom_providers WHERE id = ?').get(id) as any
    if (!provider) {
      provider = db.prepare('SELECT * FROM custom_providers WHERE provider_key = ?').get(id) as any
    }
    if (!provider) {
      ctx.status = 404
      ctx.body = { error: 'Provider not found' }
      return
    }
    const realId = provider.id

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
    values.push(realId)

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

    // 兼容两种 id 语义：custom_providers.id（preset-xxx）或 provider_key（deepseek）
    let provider = db.prepare('SELECT * FROM custom_providers WHERE id = ?').get(body.providerId) as any
    if (!provider) {
      provider = db.prepare('SELECT * FROM custom_providers WHERE provider_key = ?').get(body.providerId) as any
    }
    if (!provider) {
      ctx.status = 404
      ctx.body = { error: 'Provider not found' }
      return
    }
    const realProviderId = provider.id

    const id = randomUUID()
    db.prepare(`
      INSERT INTO custom_models (id, provider_id, model_id, display_name, enabled, is_default)
      VALUES (?, ?, ?, ?, 1, 0)
    `).run(id, realProviderId, body.modelId, body.displayName || body.modelId)

    ctx.body = {
      success: true,
      model: {
        id,
        providerId: realProviderId,
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
// Discover — 用用户 API Key 拉取该渠道可用模型列表
// ========================
modelsRouter.post('/discover', async (ctx: Context) => {
  const { providerId, apiKey, baseUrl } = (ctx.request.body as any) || {}
  if (!apiKey || !baseUrl) {
    ctx.status = 400
    ctx.body = { error: 'apiKey and baseUrl required' }
    return
  }

  const normalize = (u: string) => u.replace(/\/v1\/?$/, '')
  let url = ''
  let headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let parseModels: (json: any) => string[] = (json) =>
    (json?.data || []).map((m: any) => m.id).filter(Boolean)

  if (providerId === 'ollama') {
    // Ollama 本地模型:GET /api/tags → { models: [{ name: 'llama3.1:8b' }] }
    url = `${normalize(baseUrl)}/api/tags`
    parseModels = (json) =>
      (json?.models || []).map((m: any) => m.name).filter(Boolean)
  } else if (providerId === 'anthropic') {
    // Anthropic 原生：x-api-key 头 + anthropic-version
    url = `${normalize(baseUrl)}/models`
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else if (providerId === 'gemini') {
    // Gemini：x-goog-api-key 头，models[].name 带 'models/' 前缀
    url = `${baseUrl}/models`
    headers['x-goog-api-key'] = apiKey
    parseModels = (json) =>
      (json?.models || []).map((m: any) => String(m.name || '').replace(/^models\//, '')).filter(Boolean)
  } else {
    // OpenAI 兼容：Bearer + /models
    url = `${normalize(baseUrl)}/models`
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const resp = await fetch(url, { headers, signal: controller.signal })
    if (resp.status === 401 || resp.status === 403) {
      ctx.status = 401
      ctx.body = { error: 'API Key 无效或无权限' }
      return
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      ctx.status = resp.status
      ctx.body = { error: text.slice(0, 200) || `请求失败 (${resp.status})` }
      return
    }
    const json = await resp.json().catch(() => ({}))
    const models = parseModels(json)
    if (models.length === 0) {
      ctx.body = { models: [], error: '未识别到可用模型' }
      return
    }
    ctx.body = { models }
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err.name === 'AbortError' ? '请求超时' : `请求失败: ${err.message}` }
  } finally {
    clearTimeout(timer)
  }
})

// ========================
// Utilities
// ========================

function safeJson(val: string): any[] {
  try { return JSON.parse(val) } catch { return [] }
}
