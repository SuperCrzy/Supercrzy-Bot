/**
 * 钉钉 Bot 服务（Stream Mode 长连接）
 * 接入钉钉机器人 Stream 模式：注册 ticket → WebSocket 长连接 → 收消息 → sessionWebhook 回复
 * 免公网回调、免加解密、免防火墙，本地开发即可
 *
 * 协议: https://open.dingtalk.com/document/dingstart/robot-receive-message
 * 1. POST /v1.0/gateway/connections/open 注册连接凭证（clientId/clientSecret/subscriptions）
 * 2. WS 连接 wss://{endpoint}/connect?ticket={ticket}
 * 3. 每 8s 心跳 ping，收到 CALLBACK 帧需回 ACK
 * 4. 回复走入站消息附带的 sessionWebhook URL（POST JSON）
 */
import WebSocket from 'ws'
import { getDB } from '../services/database'
import { formatForChannel } from '../services/channel-format'

// ── 类型定义 ──────────────────────────────────────────

interface DingtalkChannelConfig {
  id: string
  name: string
  config: {
    clientId: string
    clientSecret: string
    allowedUserIds?: string
  }
}

interface StreamFrame {
  type: string
  code?: number
  headers?: Record<string, string>
  topic?: string
  callbackId?: string
  data?: any
}

// ── 常量 ──────────────────────────────────────────────

const DINGTALK_OPEN_API = 'https://api.dingtalk.com'
const TOPIC_BOT_MESSAGE = '/v1.0/im/bot/messages/get'
const HEARTBEAT_MS = 8000

// ── 状态管理 ──────────────────────────────────────────

const activeBots = new Map<string, DingtalkBotInstance>()

// ── 工具函数 ──────────────────────────────────────────

/** 注册 Stream 连接凭证，返回 endpoint + ticket */
async function openStreamConnection(clientId: string, clientSecret: string): Promise<{ endpoint: string; ticket: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const r = await fetch(`${DINGTALK_OPEN_API}/v1.0/gateway/connections/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        clientSecret,
        localIp: '127.0.0.1',
        subscriptions: [
          { topic: TOPIC_BOT_MESSAGE, type: 'CALLBACK' },
        ],
        ua: 'supercrzy-agent/1.0',
      }),
      signal: controller.signal,
    })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      throw new Error(`注册 Stream 连接失败: ${r.status} ${errText.slice(0, 200)}`)
    }
    const data = await r.json() as any
    if (!data.endpoint || !data.ticket) {
      throw new Error(`注册响应缺少 endpoint/ticket: ${JSON.stringify(data).slice(0, 200)}`)
    }
    return { endpoint: data.endpoint, ticket: data.ticket }
  } finally {
    clearTimeout(timer)
  }
}

/** 验证 clientId/clientSecret 有效性（注册 Stream 连接） */
export async function testDingtalkCreds(clientId: string, clientSecret: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await openStreamConnection(clientId, clientSecret)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

/** 提取文本（text 或 rich text） */
function extractText(data: any): string {
  const text = data.text
  if (text && typeof text === 'object') return (text.content || '').trim()
  if (typeof text === 'string') return text.trim()
  // 富文本降级
  if (data.rich_text_content?.rich_text_list) {
    const parts: string[] = []
    for (const item of data.rich_text_content.rich_text_list) {
      if (item.type === 'text' && item.text) parts.push(item.text)
    }
    return parts.join(' ').trim()
  }
  return ''
}

/** 判断是否应处理：单聊全处理（可选白名单）；群聊需 @机器人 */
function shouldProcess(data: any, allowList: Set<string> | null): boolean {
  const senderId = data.senderStaffId || data.senderId || ''
  const convType = String(data.conversationType || '')
  if (convType === '1') { // 单聊
    if (allowList && allowList.size > 0) return allowList.has(senderId)
    return true
  }
  // 群聊：需被 @
  return data.isInAtList === true
}

// ── Bot 实例 ──────────────────────────────────────────

class DingtalkBotInstance {
  private config: DingtalkChannelConfig
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private reconnectAttempts = 0
  private maxReconnect = 10
  private allowList: Set<string> | null = null

  constructor(config: DingtalkChannelConfig) {
    this.config = config
  }

  async start(): Promise<boolean> {
    if (this.running) return true
    try {
      const allowRaw = this.config.config.allowedUserIds?.trim()
      this.allowList = allowRaw ? new Set(allowRaw.split(',').map(s => s.trim()).filter(Boolean)) : null
      // 先注册验证凭据
      await openStreamConnection(this.config.config.clientId, this.config.config.clientSecret)
      console.log(`[钉钉] ✅ 凭据验证通过 (${this.config.name})`)
      this.running = true
      this.reconnectAttempts = 0
      void this.connect()
      this.updateDBStatus('connected')
      return true
    } catch (err: any) {
      console.error(`[钉钉] ❌ 启动失败: ${err.message}`)
      this.running = false
      this.updateDBStatus('error')
      return false
    }
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
    if (this.ws) {
      try { this.ws.close(1000) } catch {}
      this.ws = null
    }
    this.updateDBStatus('disconnected')
    console.log(`[钉钉] ⏹️ 已停止 (${this.config.name})`)
  }

  private async connect() {
    if (!this.running) return
    try {
      const { endpoint, ticket } = await openStreamConnection(this.config.config.clientId, this.config.config.clientSecret)
      const url = `wss://${endpoint}/connect?ticket=${encodeURIComponent(ticket)}`
      console.log(`[钉钉] 🔗 连接 Stream: ${url.slice(0, 60)}...`)
      this.ws = new WebSocket(url)

      this.ws.on('open', () => {
        console.log(`[钉钉] 🔌 Stream 已连接`)
        this.reconnectAttempts = 0
      })

      this.ws.on('message', (data: Buffer) => {
        try {
          const frame: StreamFrame = JSON.parse(data.toString())
          this.handleFrame(frame).catch(err => {
            console.error(`[钉钉] 帧处理失败: ${err.message}`)
          })
        } catch (err) {
          console.error('[钉钉] 消息解析失败:', err)
        }
      })

      this.ws.on('close', (code: number) => {
        console.log(`[钉钉] ⚠️ Stream 关闭 (code=${code})`)
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
        this.ws = null
        if (this.running && this.reconnectAttempts < this.maxReconnect) {
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
          this.reconnectAttempts++
          console.log(`[钉钉] 🔄 ${delay / 1000}s 后重连 (第${this.reconnectAttempts}次)...`)
          setTimeout(() => this.connect(), delay)
        }
      })

      this.ws.on('error', (err: Error) => {
        console.error(`[钉钉] WebSocket 错误: ${err.message}`)
      })

      // 8s 心跳
      this.heartbeatTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping()
        }
      }, HEARTBEAT_MS)
    } catch (err: any) {
      console.error(`[钉钉] 连接失败: ${err.message}`)
      if (this.running) {
        this.reconnectAttempts++
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000)
        setTimeout(() => this.connect(), delay)
      }
    }
  }

  private async handleFrame(frame: StreamFrame) {
    switch (frame.type) {
      case 'SYSTEM':
        // 服务端心跳/系统消息：SYSTEM.CONNECTED / SYSTEM.REGISTERED / SYSTEM.KEEPALIVE
        if (frame.code === 200 && frame.data?.type === 'SYSTEM.KEEPALIVE') {
          this.send({ type: 'system', data: { type: 'SYSTEM.KEEPALIVE' } })
        }
        break
      case 'CALLBACK': {
        // 业务回调：topic=/v1.0/im/bot/messages/get
        const callbackId = frame.callbackId || frame.data?.messageId || ''
        const msgData = frame.data?.data || frame.data || {}
        const topic = frame.topic || ''

        // 先 ACK，避免钉钉超时重推
        if (callbackId) {
          this.send({ type: 'callbackAck', callbackId, data: { success: true } })
        }

        if (topic === TOPIC_BOT_MESSAGE) {
          await this.handleBotMessage(msgData)
        }
        break
      }
      default:
        break
    }
  }

  private send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private async handleBotMessage(data: any) {
    if (!shouldProcess(data, this.allowList)) return
    const text = extractText(data)
    if (!text) return

    const senderNick = data.senderNick || data.senderStaffId || 'unknown'
    const isGroup = String(data.conversationType || '') === '2'
    console.log(`[钉钉] ${isGroup ? '群聊' : '单聊'} [${senderNick}]: ${text.slice(0, 60)}`)

    // 回复走 sessionWebhook（入站消息附带，有过期时间）
    const sessionWebhook = data.sessionWebhook
    if (!sessionWebhook) {
      console.warn(`[钉钉] 无 sessionWebhook，跳过回复`)
      return
    }

    try {
      const reply = await callAgent(text)
      if (!reply) return
      await this.sendBySessionWebhook(sessionWebhook, formatForChannel(reply, 'dingtalk'))
      console.log(`[钉钉] 回复已发送 (${reply.length} chars)`)
    } catch (err: any) {
      console.error(`[钉钉] agent 调用失败: ${err.message}`)
    }
  }

  /** 通过 sessionWebhook 回复（钉钉单条 20000 字符） */
  private async sendBySessionWebhook(webhook: string, text: string): Promise<void> {
    const MAX = 18000
    if (text.length <= MAX) {
      await this.postWebhook(webhook, text)
      return
    }
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += MAX) {
      chunks.push(text.slice(i, i + MAX))
    }
    for (let i = 0; i < chunks.length; i++) {
      const prefix = i === 0 ? '' : `\n(${i + 1}/${chunks.length})\n`
      await this.postWebhook(webhook, prefix + chunks[i])
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 400))
    }
  }

  private async postWebhook(webhook: string, content: string): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const r = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content } }),
        signal: controller.signal,
      })
      if (!r.ok) {
        const errText = await r.text().catch(() => '')
        throw new Error(`sessionWebhook 发送失败: ${r.status} ${errText.slice(0, 200)}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private updateDBStatus(status: 'disconnected' | 'connected' | 'error') {
    try {
      getDB().prepare("UPDATE channels SET status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(status, this.config.id)
    } catch { /* 数据库可能未初始化 */ }
  }
}

// ── 调用 SUPERCRZY agent（SSE 流，聚合完整回复） ──

async function callAgent(userText: string): Promise<string> {
  try {
    const res = await fetch(`http://localhost:${process.env.PORT || '3000'}/api/chat/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: userText }],
      }),
    })
    if (!res.ok) return 'Sorry, Agent is busy.'

    const reader = res.body?.getReader()
    if (!reader) return ''
    const decoder = new TextDecoder()
    let buf = ''
    let result = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      for (const line of buf.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const d = JSON.parse(line.slice(6))
            if (d.type === 'block' && d.block?.type === 'text' && d.block?.text) {
              result = d.block.text
            } else if (d.content) {
              result = d.content
            }
          } catch { /* 忽略非 JSON 行 */ }
        }
      }
      buf = buf.includes('\n') ? buf.split('\n').pop() || '' : ''
    }
    return result || 'No response'
  } catch {
    return 'Sorry, something went wrong.'
  }
}

// ── 公开 API（与 gateway.ts 接入） ─────────────────────

export async function startDingtalkChannel(channelId: string): Promise<boolean> {
  const db = getDB()
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND platform = ?')
    .get(channelId, 'dingtalk') as any

  if (!channel) {
    console.error(`[钉钉] 通道不存在: ${channelId}`)
    return false
  }

  const existing = activeBots.get(channelId)
  if (existing) {
    await existing.stop()
  }

  const parsedConfig: DingtalkChannelConfig = {
    id: channel.id,
    name: channel.name,
    config: JSON.parse(channel.config || '{}'),
  }

  if (!parsedConfig.config.clientId || !parsedConfig.config.clientSecret) {
    console.error(`[钉钉] 配置不完整（缺少 Client ID/Secret）: ${channelId}`)
    return false
  }

  const bot = new DingtalkBotInstance(parsedConfig)
  activeBots.set(channelId, bot)
  const ok = await bot.start()
  if (!ok) activeBots.delete(channelId)
  return ok
}

export async function stopDingtalkChannel(channelId: string): Promise<boolean> {
  const bot = activeBots.get(channelId)
  if (!bot) return false
  await bot.stop()
  activeBots.delete(channelId)
  return true
}

export async function startAllDingtalkChannels() {
  const db = getDB()
  const channels = db.prepare(
    "SELECT * FROM channels WHERE platform = 'dingtalk' AND enabled = 1"
  ).all() as any[]

  for (const ch of channels) {
    console.log(`[钉钉] 🚀 启动通道: ${ch.name} (${ch.id})`)
    await startDingtalkChannel(ch.id)
  }
}

export async function stopAllDingtalkChannels() {
  for (const [id, bot] of activeBots) {
    await bot.stop()
  }
  activeBots.clear()
}

export function getDingtalkChannelStatus(channelId: string): 'connected' | 'disconnected' | 'error' | 'not_found' {
  const bot = activeBots.get(channelId)
  if (!bot) return 'not_found'
  return 'connected'
}
