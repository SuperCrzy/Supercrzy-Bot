/**
 * QQ Bot WebSocket 连接服务
 * 接入 QQ 开放平台机器人，支持群聊@和私聊
 *
 * 协议: QQ Bot WebSocket v2
 * 文档: https://bot.q.qq.com/wiki/develop/api-v2/
 */
import WebSocket from 'ws'
import { getDB } from '../services/database'
import { config } from '../config'

// ── 类型定义 ──────────────────────────────────────────

interface QQChannelConfig {
  id: string
  name: string
  config: {
    appId: string
    appSecret: string
    botAppId: string
  }
}

interface QQWSPayload {
  op: number
  d?: any
  s?: number
  t?: string
  id?: string
}

// ── 常量 ──────────────────────────────────────────────

const QQ_API_BASE = 'https://api.sgroup.qq.com'
const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const QQ_WS_URL = 'wss://api.sgroup.qq.com/websocket'

// 需要监听的事件 Intents
const INTENTS =
  (1 << 25) | // GROUP_AND_C2C_EVENT (群@消息 + 私聊)
  (1 << 30) | // PUBLIC_GUILD_MESSAGES (公域频道消息)
  (1 << 12)   // DIRECT_MESSAGE (频道私信)

// ── 状态管理 ──────────────────────────────────────────

const activeBots = new Map<string, QQBotInstance>()

// ── 工具函数 ──────────────────────────────────────────

async function fetchAccessToken(appId: string, appSecret: string): Promise<string> {
  const r = await fetch(QQ_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
  })
  const data = await r.json() as any
  if (!r.ok || !data.access_token) {
    throw new Error(`获取QQ Access Token失败: ${JSON.stringify(data)}`)
  }
  return data.access_token
}

/**
 * 动态获取 WebSocket Gateway 地址
 * 文档: https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
 */
async function fetchGatewayUrl(token: string): Promise<string> {
  try {
    const r = await fetch(`${QQ_API_BASE}/gateway`, {
      headers: { Authorization: `QQBot ${token}` },
    })
    const data = await r.json() as any
    if (data.url) {
      console.log(`[QQ Bot] 🌐 Gateway 地址: ${data.url}`)
      return data.url
    }
  } catch (err) {
    console.warn('[QQ Bot] ⚠️ 获取 Gateway 地址失败，使用默认地址')
  }
  return QQ_WS_URL
}

/**
 * 调用 SUPERCRZY Agent 获取回复
 */
async function callAgent(userMessage: string, userName: string): Promise<string> {
  const db = getDB()
  const apiKeyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any
  const apiKey = apiKeyRow?.value || config.deepseek.apiKey

  if (!apiKey) {
    return '🤖 Agent 未配置 API Key，请在设置中填写。'
  }

  const systemPrompt = (db.prepare('SELECT value FROM settings WHERE key = ?').get('systemPrompt') as any)?.value || ''

  const r = await fetch(`${config.deepseek.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseek.defaultModel,
      messages: [
        { role: 'system', content: systemPrompt || '你是一个友好的AI助手，中文回复。' },
        { role: 'user', content: `[用户 ${userName}]: ${userMessage}` },
      ],
      temperature: 0.7,
      max_tokens: 2000,
    }),
  })

  const data = await r.json() as any
  return data.choices?.[0]?.message?.content || '(暂无回复)'
}

/**
 * 向 QQ 发送消息
 */
async function sendQQMessage(
  token: string,
  channelId: string,
  msgId: string,
  content: string,
  msgType: 'group' | 'c2c' | 'channel'
) {
  let url: string
  let body: any

  if (msgType === 'c2c') {
    url = `${QQ_API_BASE}/v2/users/${channelId}/messages`
    body = { content, msg_id: msgId, msg_type: 0 }
  } else if (msgType === 'group') {
    url = `${QQ_API_BASE}/v2/groups/${channelId}/messages`
    body = { content, msg_id: msgId, msg_type: 0 }
  } else {
    url = `${QQ_API_BASE}/v2/channels/${channelId}/messages`
    body = { content, msg_id: msgId }
  }

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `QQBot ${token}`,
    },
    body: JSON.stringify(body),
  })

  if (!r.ok) {
    const err = await r.text()
    console.error(`[QQ Bot] 发送消息失败: ${r.status} ${err}`)
  }
}

// ── Bot 实例 ──────────────────────────────────────────

class QQBotInstance {
  private config: QQChannelConfig
  private ws: WebSocket | null = null
  private token: string = ''
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private seq: number = 0
  private sessionId: string = ''
  private reconnectAttempts: number = 0
  private maxReconnect: number = 10
  private running: boolean = false

  constructor(config: QQChannelConfig) {
    this.config = config
  }

  async start() {
    if (this.running) return
    this.running = true

    try {
      console.log(`[QQ Bot] 🔑 获取 Access Token...`)
      this.token = await fetchAccessToken(this.config.config.appId, this.config.config.appSecret)
      console.log(`[QQ Bot] ✅ Token 获取成功`)
      await this.connect()
    } catch (err: any) {
      console.error(`[QQ Bot] ❌ 启动失败: ${err.message}`)
      this.running = false
      this.updateDBStatus('error')
    }
  }

  async stop() {
    this.running = false
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.updateDBStatus('disconnected')
    console.log(`[QQ Bot] ⏹️ 已停止`)
  }

  private async connect() {
    if (!this.running) return

    console.log(`[QQ Bot] 🔗 获取 Gateway 地址...`)
    const wsUrl = await fetchGatewayUrl(this.token)
    console.log(`[QQ Bot] 🔗 连接 WebSocket: ${wsUrl}`)
    this.ws = new WebSocket(wsUrl)

    this.ws.on('open', () => {
      console.log(`[QQ Bot] 🔌 WebSocket 已连接`)
      this.updateDBStatus('connected')
      this.reconnectAttempts = 0
    })

    this.ws.on('message', async (data: Buffer) => {
      try {
        const payload: QQWSPayload = JSON.parse(data.toString())
        if (payload.s) this.seq = payload.s
        await this.handlePayload(payload)
      } catch (err) {
        console.error('[QQ Bot] 消息解析失败:', err)
      }
    })

    this.ws.on('close', (code: number) => {
      console.log(`[QQ Bot] ⚠️ WebSocket 关闭 (code=${code})`)
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      this.ws = null
      this.updateDBStatus('disconnected')

      if (this.running && this.reconnectAttempts < this.maxReconnect) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
        this.reconnectAttempts++
        console.log(`[QQ Bot] 🔄 ${delay/1000}s 后重连 (第${this.reconnectAttempts}次)...`)
        setTimeout(() => this.connect(), delay)
      }
    })

    this.ws.on('error', (err: Error) => {
      console.error(`[QQ Bot] WebSocket 错误: ${err.message}`)
    })
  }

  private async handlePayload(payload: QQWSPayload) {
    switch (payload.op) {
      case 10: // HELLO - 收到心跳间隔
        this.startHeartbeat(payload.d?.heartbeat_interval || 30000)
        this.identify()
        break

      case 0: // DISPATCH - 事件分发
        await this.handleEvent(payload.t || '', payload.d || {})
        break

      case 11: // HEARTBEAT ACK
        break

      case 7: // RECONNECT
        console.log('[QQ Bot] 服务端要求重连')
        if (this.ws) this.ws.close()
        break

      default:
        console.log(`[QQ Bot] 未知 op=${payload.op}`)
    }
  }

  private startHeartbeat(interval: number) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.seq }))
      }
    }, interval)
  }

  private identify() {
    const payload = {
      op: 2,
      d: {
        token: `QQBot ${this.token}`,
        intents: INTENTS,
        shard: [0, 1] as [number, number],
        properties: { os: 'macOS', browser: 'supercrzy-agent' },
      },
    }
    this.ws?.send(JSON.stringify(payload))
    console.log(`[QQ Bot] 📡 已发送 IDENTIFY`)
  }

  private async handleEvent(eventType: string, data: any) {
    switch (eventType) {
      case 'READY': {
        this.sessionId = data.session_id || ''
        console.log(`[QQ Bot] ✅ READY - session=${this.sessionId}`)
        break
      }

      case 'C2C_MESSAGE_CREATE': {
        const authorName = data.author?.username || data.author?.id || '未知'
        console.log(`[QQ Bot] 💬 私聊 [${authorName}]: ${data.content}`)
        const reply = await callAgent(data.content || '', authorName)
        await sendQQMessage(this.token, data.author.id, data.id, reply, 'c2c')
        break
      }

      case 'GROUP_AT_MESSAGE_CREATE': {
        const authorName = data.author?.username || data.author?.id || '未知'
        console.log(`[QQ Bot] 👥 群聊 [${authorName}@${data.group_openid}]: ${data.content}`)
        const reply = await callAgent(data.content || '', authorName)
        await sendQQMessage(this.token, data.group_openid, data.id, reply, 'group')
        break
      }

      case 'AT_MESSAGE_CREATE': {
        const authorName = data.author?.username || data.author?.id || '未知'
        console.log(`[QQ Bot] 📢 频道 [${authorName}]: ${data.content}`)
        const reply = await callAgent(data.content || '', authorName)
        await sendQQMessage(this.token, data.channel_id, data.id, reply, 'channel')
        break
      }

      default: {
        // 忽略其他事件
      }
    }
  }

  private updateDBStatus(status: 'disconnected' | 'connected' | 'error') {
    try {
      const db = getDB()
      db.prepare("UPDATE channels SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(status, this.config.id)
    } catch { /* 数据库可能未初始化 */ }
  }
}

// ── 公开 API ──────────────────────────────────────────

export async function startQQChannel(channelId: string): Promise<boolean> {
  const db = getDB()
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND platform = ?')
    .get(channelId, 'qq') as any

  if (!channel) {
    console.error(`[QQ Bot] 通道不存在: ${channelId}`)
    return false
  }

  const existing = activeBots.get(channelId)
  if (existing) {
    await existing.stop()
  }

  const parsedConfig: QQChannelConfig = {
    id: channel.id,
    name: channel.name,
    config: JSON.parse(channel.config || '{}'),
  }

  if (!parsedConfig.config.appId || !parsedConfig.config.appSecret) {
    console.error(`[QQ Bot] 配置不完整: ${channelId}`)
    return false
  }

  const bot = new QQBotInstance(parsedConfig)
  activeBots.set(channelId, bot)
  await bot.start()
  return true
}

export async function stopQQChannel(channelId: string): Promise<boolean> {
  const bot = activeBots.get(channelId)
  if (!bot) return false

  await bot.stop()
  activeBots.delete(channelId)
  return true
}

export async function startAllQQChannels() {
  const db = getDB()
  const channels = db.prepare(
    "SELECT * FROM channels WHERE platform = 'qq' AND enabled = 1"
  ).all() as any[]

  for (const ch of channels) {
    console.log(`[QQ Bot] 🚀 启动通道: ${ch.name} (${ch.id})`)
    await startQQChannel(ch.id)
  }
}

export async function stopAllQQChannels() {
  for (const [id, bot] of activeBots) {
    await bot.stop()
  }
  activeBots.clear()
}

export function getQQChannelStatus(channelId: string): 'connected' | 'disconnected' | 'error' | 'not_found' {
  const bot = activeBots.get(channelId)
  if (!bot) return 'not_found'
  return 'connected'
}
