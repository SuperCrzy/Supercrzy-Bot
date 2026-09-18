import Router from 'koa-router'
import type { Context } from 'koa'
import { randomBytes } from 'crypto'
import { getDB } from '../services/database'

export const settingsRouter = new Router({ prefix: '/api/settings' })

/** 密钥脱敏：前 headLen 位 + ... + 后 4 位（导出供单测） */
export function maskSecret(value: string, headLen: number): string {
  return value.slice(0, headLen) + '...' + value.slice(-4)
}

// Numeric keys that should be parsed as float
const FLOAT_KEYS = ['temperature', 'maxTokens', 'maxTurns', 'gatewayTimeout', 'memoryCharLimit', 'idleTimeout']

// Boolean keys that should be parsed as boolean
const BOOL_KEYS = ['streamingEnabled', 'compactMode', 'showReasoning', 'showCost', 'completionSound', 'busyInputMode', 'memoryEnabled', 'piiMaskingEnabled', 'memoryAutoConsolidate']

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
  // 脱敏：不返回明文密钥，只返回 masked + 布尔标记（ModelsView/SettingsView 已适配）
  if (settings.apiKey) {
    settings.apiKeyMasked = maskSecret(settings.apiKey, 8)
    settings.hasApiKey = true
    delete settings.apiKey
  }
  if (settings.qqAppSecret) {
    settings.qqAppSecretMasked = maskSecret(settings.qqAppSecret, 4)
    settings.hasQqAppSecret = true
    delete settings.qqAppSecret
  }
  // 访问令牌：不返回明文，只返回 masked + 标记（明文仅在生成时一次性展示）
  if (settings.accessToken) {
    settings.accessTokenMasked = maskSecret(settings.accessToken, 8)
    settings.hasAccessToken = true
    delete settings.accessToken
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
      'language', 'theme', 'currentSessionId',
      // 显示 Display
      'streamingEnabled', 'compactMode', 'showReasoning', 'showCost',
      'completionSound', 'busyInputMode',
      // 代理 Agent
      'maxTurns', 'gatewayTimeout',
      // 记忆 Memory
      'memoryEnabled', 'memoryCharLimit', 'memoryAutoConsolidate',
      // 隐私 Privacy
      'piiMaskingEnabled',
      // 工具授权模式（auto=始终允许 / prompt=每次询问 / deny=一律拒绝）——历史内部档位
      'toolApprovalMode', 'toolAutoApproveSeconds', 'reasoningLevel', 'fallbackModel',
      // P0-04 用户面向的三档权限（readonly 仅查看 / ask 执行前询问 / auto 自动执行），优先于 toolApprovalMode
      'permissionTier',
      // Tavily 搜索 API key（web_search 工具优先用，未配置时回退 Serper/Bing RSS）
      'tavilyApiKey',
      // Serper 搜索 API key（Google 原生结果，免费 2500 次/月；服务端执行不受本地网络限制）
      'serperApiKey',
      // SearXNG 自建元搜索地址（如 http://VPS_IP:8080；聚合 70+ 引擎，配了之后 Serper/Bing 之间优先）
      'searxngUrl',
      // Jina Reader API key（web_fetch 优先用官方端点，更稳定、免费 100w token/月）
      'jinaApiKey',
      // Embedding 混合检索（memory_recall：FTS5 + 语义余弦融合 α=0.8；配 key 才激活，默认硅基流动 BGE-M3）
      'embeddingApiKey', 'embeddingBaseUrl', 'embeddingModel',
      // 生图 Provider 配置（generate_image 工具：pollinations 免key / doubao 火山方舟 / gemini 谷歌 / stability / replicate / openai）
      'imageProvider', 'imageApiKey', 'doubaoModel', 'geminiImageModel', 'openaiImageModel', 'replicateModel',
      // 账户 Account
      'username', 'userName', 'userAvatar', 'accessToken',
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
      if (body[key] === undefined) continue
      // 保护：apiKey 空串不覆盖已有 key（脱敏后前端 form 回显为空，整体保存会误清空）
      if (key === 'apiKey' && String(body[key]).trim() === '') continue
      const value = typeof body[key] === 'boolean' ? String(body[key]) : typeof body[key] === 'number' ? String(body[key]) : String(body[key])
      stmt.run(key, value)
    }

    ctx.body = { success: true }
  } catch (err: any) {
    console.error('[settings] POST error:', err.message)
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// 生成新的访问令牌（旧令牌立即失效）。明文仅在本次响应返回，后续只能看到掩码
settingsRouter.post('/token', (ctx: Context) => {
  const db = getDB()
  const token = randomBytes(24).toString('hex')
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('accessToken', ?, datetime('now'))").run(token)
  ctx.body = { token, masked: maskSecret(token, 8) }
})
