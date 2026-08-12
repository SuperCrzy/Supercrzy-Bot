/**
 * QQ Bot WebSocket Client
 *
 * 协议: QQ Bot API v2 WebSocket 方式
 * 流程: getToken → getGateway → connect → Hello → Identify → Ready → heartbeat ↔ Dispatch
 * 断线: Resume (OpCode 6) 补发遗漏事件
 */
import WebSocket from 'ws'
import { EventEmitter } from 'events'

const API_BASE = 'https://api.sgroup.qq.com'
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'

// 开放平台凭证
export interface QQBotConfig {
  appId: string
  appSecret: string
  intents: number
}

// 微信消息事件负载
export interface QQMessageEvent {
  id: string
  author: { id: string; username?: string }
  content: string
  channel_id?: string
  guild_id?: string
  group_openid?: string
  timestamp: string
}

// 事件类型枚举
export type QQEventType =
  | 'C2C_MESSAGE_CREATE'       // 私聊
  | 'GROUP_AT_MESSAGE_CREATE'  // 群聊@
  | 'AT_MESSAGE_CREATE'        // 频道@
  | 'DIRECT_MESSAGE_CREATE'     // 频道私信

// Token 缓存
let accessToken = ''
let tokenExpiresAt = 0

/** 获取/刷新 AccessToken（自动处理过期） */
export async function ensureToken(config: QQBotConfig): Promise<string> {
  const now = Date.now()
  if (accessToken && now < tokenExpiresAt - 60000) {
    return accessToken
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: config.appId, clientSecret: config.appSecret }),
  })

  if (!res.ok) {
    throw new Error(`QQ Token API error: ${res.status}`)
  }

  const data = await res.json() as any
  if (!data.access_token) {
    throw new Error('QQ Token API: no access_token in response')
  }

  accessToken = data.access_token
  tokenExpiresAt = now + (data.expires_in || 7200) * 1000
  console.log(`[QQBot] Token refreshed, expires in ${data.expires_in}s`)
  return accessToken
}

/** 获取网关 WebSocket 地址 */
export async function getGatewayUrl(token: string): Promise<string> {
  const res = await fetch(`${API_BASE}/gateway/bot`, {
    headers: { Authorization: `QQBot ${token}` },
  })
  if (!res.ok) throw new Error(`QQ Gateway API error: ${res.status}`)
  const data = await res.json() as any
  return data.url
}

/** 发送消息 REST API */
export async function sendQQMessage(
  token: string,
  params: {
    msg_type: number
    content: string
    openid?: string       // C2C
    group_openid?: string  // 群聊
    channel_id?: string    // 频道
    guild_id?: string      // 频道私信
    msg_id?: string        // 被动回复
    event_id?: string
  }
): Promise<void> {
  let url = ''
  const body: any = { content: params.content, msg_type: params.msg_type }

  if (params.openid) {
    url = `${API_BASE}/v2/users/${params.openid}/messages`
  } else if (params.group_openid) {
    url = `${API_BASE}/v2/groups/${params.group_openid}/messages`
  } else if (params.channel_id) {
    url = `${API_BASE}/channels/${params.channel_id}/messages`
  } else if (params.guild_id) {
    url = `${API_BASE}/dms/${params.guild_id}/messages`
  } else {
    throw new Error('No valid target for sendQQMessage')
  }

  if (params.msg_id) body.msg_id = params.msg_id
  if (params.event_id) body.event_id = params.event_id

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `QQBot ${token}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`QQ Send error ${res.status}: ${err.slice(0, 200)}`)
  }
}

/** QQ Bot WebSocket 客户端 */
export class QQBotClient extends EventEmitter {
  private config: QQBotConfig
  private ws: WebSocket | null = null
  private seq: number | null = null
  private sessionId = ''
  private heartbeatTimer: NodeJS.Timeout | null = null
  private heartbeatAckTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private heartbeatInterval = 45000
  private token = ''
  private running = false

  constructor(config: QQBotConfig) {
    super()
    this.config = config
  }

  /** 启动连接 */
  async start(): Promise<void> {
    this.running = true
    this.token = await ensureToken(this.config)

    try {
      await this.connect()
    } catch (err: any) {
      console.error('[QQBot] Start failed:', err.message)
      this.scheduleReconnect()
    }
  }

  /** 建立 WebSocket 连接 */
  private async connect(): Promise<void> {
    if (!this.running) return

    this.token = await ensureToken(this.config)
    const wssUrl = await getGatewayUrl(this.token)
    console.log(`[QQBot] Connecting to ${wssUrl}`)

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wssUrl)

      this.ws.on('open', () => {
        console.log('[QQBot] WebSocket connected')
      })

      this.ws.on('message', (raw) => {
        try {
          const payload = JSON.parse(raw.toString())
          this.handlePayload(payload, resolve)
        } catch {
          // ignore malformed
        }
      })

      this.ws.on('close', (code, reason) => {
        console.log(`[QQBot] WS closed: ${code} ${reason}`)
        this.onClose()
      })

      this.ws.on('error', (err) => {
        console.error('[QQBot] WS error:', err.message)
        reject(err)
      })
    })
  }

  /** 处理 Payload 分发 */
  private handlePayload(payload: any, resolve?: (v: void) => void): void {
    const { op, d, s, t } = payload

    if (s != null) this.seq = s

    switch (op) {
      case 10: // Hello
        this.heartbeatInterval = d?.heartbeat_interval || 45000
        console.log(`[QQBot] Hello, heartbeat ${this.heartbeatInterval}ms`)
        this.identify()
        break

      case 11: // Heartbeat ACK
        this.clearHeartbeatAckTimer()
        break

      case 0: // Dispatch
        if (t === 'READY') {
          this.sessionId = d?.session_id || ''
          console.log(`[QQBot] Ready, session=${this.sessionId.slice(0, 12)}..., bot=${d?.user?.username}`)
          this.startHeartbeat()
          resolve?.()
        } else if (t === 'RESUMED') {
          console.log('[QQBot] Resumed')
          resolve?.()
        } else {
          this.handleEvent(t, d, payload.id)
        }
        break

      case 7: // Reconnect
        console.log('[QQBot] Server requested reconnect')
        this.closeWS()
        this.scheduleReconnect()
        break

      case 9: // Invalid Session
        console.warn('[QQBot] Invalid session, will re-identify')
        this.sessionId = ''
        setTimeout(() => this.identify(), 2000)
        break

      default:
        // ignore unknown opcodes
        break
    }
  }

  /** 发送 Identify */
  private identify(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return

    const payload = {
      op: 2,
      d: {
        token: `QQBot ${this.token}`,
        intents: this.config.intents,
        shard: [0, 1],
        properties: { $os: 'darwin', $browser: 'supercrzy', $device: 'supercrzy' },
      },
    }

    this.ws.send(JSON.stringify(payload))
    console.log('[QQBot] Identify sent')
  }

  /** 发送 Resume */
  private resume(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const payload = {
      op: 6,
      d: { token: `QQBot ${this.token}`, session_id: this.sessionId, seq: this.seq || 0 },
    }
    this.ws.send(JSON.stringify(payload))
    console.log(`[QQBot] Resume sent, seq=${this.seq}`)
  }

  /** 处理业务事件 */
  private handleEvent(t: string, d: any, eventId: string): void {
    const eventMap: Record<string, QQEventType> = {
      C2C_MESSAGE_CREATE: 'C2C_MESSAGE_CREATE',
      GROUP_AT_MESSAGE_CREATE: 'GROUP_AT_MESSAGE_CREATE',
      AT_MESSAGE_CREATE: 'AT_MESSAGE_CREATE',
      DIRECT_MESSAGE_CREATE: 'DIRECT_MESSAGE_CREATE',
    }

    const qqType = eventMap[t]
    if (!qqType) return // 忽略不关注的事件

    const author = d.author || d.member || {}
    const qqMsg: QQMessageEvent = {
      id: d.id || eventId,
      author: { id: author.id || d.user_openid || '', username: author.username },
      content: d.content || '',
      channel_id: d.channel_id,
      guild_id: d.guild_id,
      group_openid: d.group_openid,
      timestamp: d.timestamp || new Date().toISOString(),
    }

    console.log(`[QQBot] Event ${qqType} from ${qqMsg.author.id}: ${qqMsg.content.slice(0, 60)}`)
    this.emit('message', qqType, qqMsg)
  }

  /** 启动心跳 */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.sendHeartbeat()

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat()
    }, this.heartbeatInterval)
  }

  private sendHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ op: 1, d: this.seq }))

    // 心跳超时检测（倍间隔+5s）
    this.heartbeatAckTimer = setTimeout(() => {
      console.warn('[QQBot] Heartbeat timeout, reconnecting')
      this.closeWS()
      this.scheduleReconnect()
    }, this.heartbeatInterval * 1.5 + 5000)
  }

  private clearHeartbeatAckTimer(): void {
    if (this.heartbeatAckTimer) {
      clearTimeout(this.heartbeatAckTimer)
      this.heartbeatAckTimer = null
    }
  }

  /** 连接关闭处理 */
  private onClose(): void {
    this.stopHeartbeat()
    this.clearHeartbeatAckTimer()
    this.ws = null

    if (!this.running) return

    if (this.sessionId && this.seq != null) {
      // 尝试 Resume
      console.log('[QQBot] Attempting resume...')
      this.connect().catch(() => {
        this.sessionId = ''
        this.seq = null
        this.scheduleReconnect()
      })
    } else {
      this.scheduleReconnect()
    }
  }

  /** 调度重连 */
  private scheduleReconnect(): void {
    if (!this.running) return
    if (this.reconnectTimer) return

    this.sessionId = ''
    this.seq = null

    console.log('[QQBot] Scheduling reconnect in 5s')
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.connect()
      } catch {} // connect handles its own errors
    }, 5000)
  }

  private closeWS(): void {
    try { this.ws?.close() } catch {}
    this.ws = null
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  /** 停止客户端 */
  stop(): void {
    this.running = false
    this.stopHeartbeat()
    this.clearHeartbeatAckTimer()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.closeWS()
    console.log('[QQBot] Stopped')
  }
}
