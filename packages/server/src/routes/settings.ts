import Router from 'koa-router'
import type { Context } from 'koa'
import { getDB } from '../services/database'

export const settingsRouter = new Router({ prefix: '/api/settings' })

// Numeric keys that should be parsed as float
const FLOAT_KEYS = ['temperature', 'maxTokens', 'maxTurns', 'gatewayTimeout', 'drainTimeout', 'memoryCharLimit', 'userProfileCharLimit', 'idleTimeout', 'scheduledResetHour']

// Boolean keys that should be parsed as boolean
const BOOL_KEYS = ['streamingEnabled', 'compactMode', 'showReasoning', 'showCost', 'inlineDiff', 'completionSound', 'busyInputMode', 'memoryEnabled', 'userProfileEnabled', 'sessionAuthEnabled', 'liveMonitorHumanOnly', 'piiMaskingEnabled']

// Get all settings
settingsRouter.get('/', (ctx: Context) => {
  const db = getDB()
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
  const settings: Record<string, any> = {}
  for (const row of rows) {
    if (BOOL_KEYS.includes(row.key)) {
      settings[row.key] = row.value === 'true'
    } else if (FLOAT_KEYS.includes(row.key)) {
      settings[row.key] = parseFloat(row.value)
    } else {
      settings[row.key] = row.value
    }
  }
  // Mask API key
  if (settings.apiKey) {
    settings.apiKeyMasked = settings.apiKey.slice(0, 8) + '...' + settings.apiKey.slice(-4)
  }
  ctx.body = settings
})

// Update settings
settingsRouter.post('/', (ctx: Context) => {
  try {
    const db = getDB()
    const body = ctx.request.body as Record<string, any>
    console.log('[settings] POST body:', JSON.stringify(body))

    if (!body || typeof body !== 'object') {
      ctx.status = 400
      ctx.body = { error: 'Invalid request body' }
      return
    }

    const allowedKeys = [
      // API & Model
      'apiKey', 'model', 'systemPrompt', 'temperature', 'maxTokens', 'enabledModels',
      // UI
      'language', 'theme',
      // 显示 Display
      'streamingEnabled', 'compactMode', 'showReasoning', 'showCost',
      'inlineDiff', 'completionSound', 'busyInputMode',
      // 代理 Agent
      'maxTurns', 'gatewayTimeout', 'drainTimeout', 'toolStrategy',
      // 记忆 Memory
      'memoryEnabled', 'userProfileEnabled', 'memoryCharLimit', 'userProfileCharLimit',
      // 会话 Session
      'sessionAuthEnabled', 'resetMode', 'idleTimeout', 'scheduledResetHour', 'liveMonitorHumanOnly',
      // 隐私 Privacy
      'piiMaskingEnabled',
      // 账户 Account
      'username',
    ]
    const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))")

    // Validate model before accepting — reject unknown/disabled models from browser
    if (body.model !== undefined) {
      const model = String(body.model)
      const validModels = new Set([
        'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat',
        'mimo-v2.5-pro',
        'kimi-k2.6', 'moonshot-v1-8k',
        'gpt-4o', 'gpt-4.1',
        'claude-sonnet-4-20250514',
        'glm-4.7',
      ])
      // Check custom_models for UUID-based models
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (UUID_RE.test(model)) {
        const cm = db.prepare('SELECT id FROM custom_models WHERE id = ? AND enabled = 1').get(model)
        if (!cm) {
          console.log(`[settings] Rejecting unknown/disabled model UUID: ${model}`)
          delete body.model // strip invalid model, keep the rest
        }
      } else if (!validModels.has(model)) {
        console.log(`[settings] Rejecting unknown model: ${model}`)
        delete body.model
      }
    }

    for (const key of allowedKeys) {
      if (body[key] !== undefined) {
        const value = typeof body[key] === 'boolean' ? String(body[key]) : typeof body[key] === 'number' ? String(body[key]) : String(body[key])
        stmt.run(key, value)
      }
    }

    ctx.body = { success: true }
  } catch (err: any) {
    console.error('[settings] POST error:', err.message)
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})
