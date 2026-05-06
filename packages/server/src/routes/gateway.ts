/**
 * Channel Gateway - 平台接入网关
 * 统一管理多平台消息通道：企业微信、钉钉、飞书、QQ、微信
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { getDB } from '../services/database'

export const gatewayRouter = new Router({ prefix: '/api/gateway' })

// 平台配置接口
interface ChannelConfig {
  id: string
  platform: string
  name: string
  enabled: boolean
  config: Record<string, any>
  status: 'disconnected' | 'connected' | 'error'
  createdAt: string
  updatedAt: string
}

// 初始化 channels 表
export function initChannelsTable() {
  const db = getDB()
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 0,
      config TEXT DEFAULT '{}',
      status TEXT DEFAULT 'disconnected',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)
}

// 平台类型定义
const PLATFORM_DEFS: Record<string, {
  name: string
  icon: string
  description: string
  fields: Array<{ key: string; label: string; type: string; placeholder: string; required: boolean }>
}> = {
  wecom: {
    name: '企业微信',
    icon: 'wecom',
    description: '接入企业微信智能机器人，支持群聊和私聊',
    fields: [
      { key: 'corpId', label: '企业ID', type: 'text', placeholder: 'ww...', required: true },
      { key: 'agentId', label: 'AgentId', type: 'text', placeholder: '1000001', required: true },
      { key: 'secret', label: '应用Secret', type: 'password', placeholder: '', required: true },
      { key: 'token', label: '回调Token', type: 'text', placeholder: '', required: true },
      { key: 'encodingAesKey', label: 'EncodingAESKey', type: 'text', placeholder: '43位随机字符串', required: true },
      { key: 'webhookUrl', label: 'Webhook URL', type: 'text', placeholder: 'https://qyapi.weixin.qq.com/...', required: false },
    ],
  },
  dingtalk: {
    name: '钉钉',
    icon: 'dingtalk',
    description: '接入钉钉机器人，支持Webhook、OpenAPI和Stream模式',
    fields: [
      { key: 'appKey', label: 'AppKey', type: 'text', placeholder: 'ding...', required: true },
      { key: 'appSecret', label: 'AppSecret', type: 'password', placeholder: '', required: true },
      { key: 'robotCode', label: 'Robot Code', type: 'text', placeholder: '', required: false },
      { key: 'webhookUrl', label: 'Webhook URL', type: 'text', placeholder: 'https://oapi.dingtalk.com/...', required: false },
      { key: 'mode', label: '接入模式', type: 'select', placeholder: '', options: ['webhook', 'openapi', 'stream'], required: true },
    ],
  },
  feishu: {
    name: '飞书',
    icon: 'feishu',
    description: '接入飞书机器人，支持事件订阅和消息推送',
    fields: [
      { key: 'appId', label: 'App ID', type: 'text', placeholder: 'cli_...', required: true },
      { key: 'appSecret', label: 'App Secret', type: 'password', placeholder: '', required: true },
      { key: 'verificationToken', label: 'Verification Token', type: 'text', placeholder: '', required: false },
      { key: 'webhookUrl', label: 'Webhook URL', type: 'text', placeholder: 'https://open.feishu.cn/...', required: false },
    ],
  },
  qq: {
    name: 'QQ',
    icon: 'qq',
    description: '接入QQ开放平台机器人，支持群聊和私聊',
    fields: [
      { key: 'appId', label: 'App ID', type: 'text', placeholder: '', required: true },
      { key: 'appSecret', label: 'App Secret', type: 'password', placeholder: '', required: true },
      { key: 'botAppId', label: 'Bot App ID', type: 'text', placeholder: '', required: true },
    ],
  },
}

// GET /api/gateway/platforms - 获取支持的平台列表
gatewayRouter.get('/platforms', (ctx: Context) => {
  ctx.body = Object.entries(PLATFORM_DEFS).map(([id, def]) => ({ id, ...def }))
})

// GET /api/gateway/channels - 获取所有已配置的通道
gatewayRouter.get('/channels', (ctx: Context) => {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM channels ORDER BY created_at DESC').all() as ChannelConfig[]
  ctx.body = rows.map(r => ({ ...r, config: JSON.parse(r.config as any || '{}') }))
})

// POST /api/gateway/channels - 创建新通道
gatewayRouter.post('/channels', (ctx: Context) => {
  try {
    const db = getDB()
    const body = ctx.request.body as any
    const { id, platform, name, config } = body

    if (!platform || !name) {
      ctx.status = 400
      ctx.body = { error: 'platform and name are required' }
      return
    }

    const channelId = id || `ch_${Date.now()}`
    db.prepare(
      "INSERT OR REPLACE INTO channels (id, platform, name, config, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'disconnected', datetime('now'), datetime('now'))"
    ).run(channelId, platform, name, JSON.stringify(config || {}))

    ctx.body = { success: true, id: channelId }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// PUT /api/gateway/channels/:id - 更新通道配置
gatewayRouter.put('/channels/:id', (ctx: Context) => {
  try {
    const db = getDB()
    const { id } = ctx.params
    const body = ctx.request.body as any

    if (body.name !== undefined) {
      db.prepare("UPDATE channels SET name = ?, updated_at = datetime('now') WHERE id = ?").run(body.name, id)
    }
    if (body.config !== undefined) {
      db.prepare("UPDATE channels SET config = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(body.config), id)
    }
    if (body.enabled !== undefined) {
      const status = body.enabled ? 'connected' : 'disconnected'
      db.prepare("UPDATE channels SET enabled = ?, status = ?, updated_at = datetime('now') WHERE id = ?").run(body.enabled ? 1 : 0, status, id)
    }

    ctx.body = { success: true }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// DELETE /api/gateway/channels/:id
gatewayRouter.delete('/channels/:id', (ctx: Context) => {
  const db = getDB()
  const { id } = ctx.params
  db.prepare('DELETE FROM channels WHERE id = ?').run(id)
  ctx.body = { success: true }
})

// POST /api/gateway/channels/:id/test - 测试通道连接
gatewayRouter.post('/channels/:id/test', async (ctx: Context) => {
  const db = getDB()
  const { id } = ctx.params
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as ChannelConfig | undefined

  if (!channel) {
    ctx.status = 404
    ctx.body = { error: 'Channel not found' }
    return
  }

  // 简单连接测试（后续可扩展为真实API调用）
  const config = JSON.parse(channel.config as any || '{}')
  const hasRequired = channel.platform === 'wecom'
    ? config.corpId && config.secret
    : channel.platform === 'dingtalk'
    ? config.appKey && config.appSecret
    : config.appId

  if (hasRequired) {
    db.prepare("UPDATE channels SET status = 'connected', enabled = 1, updated_at = datetime('now') WHERE id = ?").run(id)
    ctx.body = { success: true, status: 'connected' }
  } else {
    ctx.body = { success: false, status: 'error', message: '配置不完整，请填写所有必填字段' }
  }
})
