/**
 * 企业微信智能机器人服务（WebSocket 长连接）
 * 接入企微 AI Bot 智能机器人：wss://openws.work.weixin.qq.com 长连接，免公网回调
 * 流程: aibot_subscribe 订阅 → 收 aibot_msg_callback 事件 → aibot_respond_msg 回复
 *
 * 参考: Hermes wecom adapter（智能机器人 WebSocket 模式）
 */
import { callAgent as callAgentBridge } from './agent-bridge'
import WebSocket from 'ws'
import { getDB } from '../services/database'
import { formatForChannel } from '../services/channel-format'
import { randomUUID } from 'crypto'

// ── 类型定义 ──────────────────────────────────────────

interface WecomChannelConfig {
  id: string
  name: string
  config: {
    botId: string
    secret: string
    allowedUserIds?: string
  }
}

interface WecomPayload {
  cmd?: string
  headers?: { req_id?: string }
  body?: any
  errcode?: number
  errmsg?: string
}

// ── 常量 ──────────────────────────────────────────────

const WECOM_WS_URL = 'wss://openws.work.weixin.qq.com'
const CMD_SUBSCRIBE = 'aibot_subscribe'
const CMD_CALLBACK = 'aibot_msg_callback'
const CMD_LEGACY_CALLBACK = 'aibot_callback'
const CMD_RESPONSE = 'aibot_respond_msg'
const CMD_PING = 'ping'
const HEARTBEAT_MS = 30000

// ── 状态管理 ──────────────────────────────────────────

const activeBots = new Map<string, WecomBotInstance>()

// ── 工具函数 ──────────────────────────────────────────

function newReqId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '')}`
}

function payloadReqId(payload: WecomPayload): string {
  return payload.headers?.req_id || ''
}

/** 提取消息文本 */
function extractText(body: any): string {
  if (typeof body?.text === 'string') return body.text.trim()
  if (typeof body?.text?.content === 'string') return body.text.content.trim()
  if (typeof body?.msgdata?.text?.content === 'string') return body.msgdata.text.content.trim()
  return ''
}

/** 判断是否应处理：单聊全处理（可选白名单）；群聊需 @机器人（从 text 提取） */
function shouldProcess(body: any, allowList: Set<string> | null): boolean {
  const senderId = body?.from?.userid || ''
  const chatType = String(body?.chattype || '').toLowerCase()
  if (chatType !== 'group') {
    if (allowList && allowList.size > 0) return allowList.has(senderId)
    return true
  }
  // 群聊：消息带 @ 即触发（群聊消息默认带 @bot 提及文本）
  return true
}

// ── Bot 实例 ──────────────────────────────────────────

class WecomBotInstance {
  private config: WecomChannelConfig
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private reconnectAttempts = 0
  private maxReconnect = 10
  private allowList: Set<string> | null = null
  private deviceId = ''
  private subscribed = false
  private seenMsgIds = new Set<string>()

  constructor(config: WecomChannelConfig) {
    this.config = config
  }

  async start(): Promise<boolean> {
    if (this.running) return true
    try {
      const allowRaw = this.config.config.allowedUserIds?.trim()
      this.allowList = allowRaw ? new Set(allowRaw.split(',').map(s => s.trim()).filter(Boolean)) : null
      this.deviceId = randomUUID().replace(/-/g, '')
      this.subscribed = false
      this.running = true
      this.reconnectAttempts = 0
      void this.connect()
      this.updateDBStatus('connected')
      return true
    } catch (err: any) {
      console.error(`[企微] ❌ 启动失败: ${err.message}`)
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
    console.log(`[企微] ⏹️ 已停止 (${this.config.name})`)
  }

  private async connect() {
    if (!this.running) return
    console.log(`[企微] 🔗 连接 WebSocket: ${WECOM_WS_URL}`)
    this.ws = new WebSocket(WECOM_WS_URL)
    this.subscribed = false

    this.ws.on('open', () => {
      console.log(`[企微] 🔌 WebSocket 已连接，发送订阅`)
      // 订阅（鉴权）
      this.send({
        cmd: CMD_SUBSCRIBE,
        headers: { req_id: newReqId('subscribe') },
        body: {
          bot_id: this.config.config.botId,
          secret: this.config.config.secret,
          device_id: this.deviceId,
        },
      })
    })

    this.ws.on('message', (data: Buffer) => {
      try {
        const payload: WecomPayload = JSON.parse(data.toString())
        this.handlePayload(payload).catch(err => {
          console.error(`[企微] 事件处理失败: ${err.message}`)
        })
      } catch (err) {
        console.error('[企微] 消息解析失败:', err)
      }
    })

    this.ws.on('close', (code: number) => {
      console.log(`[企微] ⚠️ WebSocket 关闭 (code=${code})`)
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
      this.ws = null
      if (this.running && this.reconnectAttempts < this.maxReconnect) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
        this.reconnectAttempts++
        console.log(`[企微] 🔄 ${delay / 1000}s 后重连 (第${this.reconnectAttempts}次)...`)
        setTimeout(() => this.connect(), delay)
      }
    })

    this.ws.on('error', (err: Error) => {
      console.error(`[企微] WebSocket 错误: ${err.message}`)
    })

    // 30s 心跳
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ cmd: CMD_PING, headers: { req_id: newReqId('ping') } })
      }
    }, HEARTBEAT_MS)
  }

  private async handlePayload(payload: WecomPayload) {
    const cmd = payload.cmd || ''

    switch (cmd) {
      case CMD_PING:
        // 服务端 ping → 回 pong（或直接忽略，aiohttp heartbeat 自动回）
        break
      case 'aibot_subscribe_ack':
      case 'aibot_subscribe_response': {
        const errcode = payload.errcode ?? payload.body?.errcode ?? 0
        if (errcode === 0 || errcode == null) {
          this.subscribed = true
          this.reconnectAttempts = 0
          console.log(`[企微] ✅ 订阅成功 (${this.config.name})`)
        } else {
          console.error(`[企微] ❌ 订阅失败: ${payload.errmsg || payload.body?.errmsg || errcode}`)
          this.updateDBStatus('error')
        }
        break
      }
      case CMD_CALLBACK:
      case CMD_LEGACY_CALLBACK: {
        const body = payload.body || {}
        const msgId = String(body.msgid || payloadReqId(payload) || randomUUID())
        if (msgId) {
          if (this.seenMsgIds.has(msgId)) return
          this.seenMsgIds.add(msgId)
          if (this.seenMsgIds.size > 500) {
            const it = this.seenMsgIds.values().next()
            if (it.value) this.seenMsgIds.delete(it.value)
          }
        }
        await this.handleMessage(payload)
        break
      }
      default:
        break
    }
  }

  private async handleMessage(payload: WecomPayload) {
    const body = payload.body || {}
    if (!shouldProcess(body, this.allowList)) return
    const text = extractText(body)
    if (!text) return

    const chatId = String(body.chatid || body.from?.userid || '')
    if (!chatId) return
    const senderId = body.from?.userid || 'unknown'
    const isGroup = String(body.chattype || '').toLowerCase() === 'group'
    console.log(`[企微] ${isGroup ? '群聊' : '单聊'} [${senderId}]: ${text.slice(0, 60)}`)

    const reqId = payloadReqId(payload)
    if (!reqId) {
      console.warn(`[企微] 无 req_id，跳过回复`)
      return
    }

    try {
      const reply = await callAgent(text)
      if (!reply) return
      await this.respond(reqId, chatId, formatForChannel(reply, 'wecom'))
      console.log(`[企微] 回复已发送 (${reply.length} chars)`)
    } catch (err: any) {
      console.error(`[企微] agent 调用失败: ${err.message}`)
    }
  }

  /** 通过 aibot_respond_msg 回复（关联入站 req_id） */
  private async respond(reqId: string, chatId: string, text: string): Promise<void> {
    const MAX = 18000
    if (text.length <= MAX) {
      await this.respondOnce(reqId, chatId, text)
      return
    }
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += MAX) {
      chunks.push(text.slice(i, i + MAX))
    }
    for (let i = 0; i < chunks.length; i++) {
      const prefix = i === 0 ? '' : `\n(${i + 1}/${chunks.length})\n`
      await this.respondOnce(reqId, chatId, prefix + chunks[i])
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 400))
    }
  }

  private async respondOnce(reqId: string, chatId: string, text: string): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 未连接')
    }
    this.send({
      cmd: CMD_RESPONSE,
      headers: { req_id: reqId },
      body: {
        chatid: chatId,
        msgtype: 'text',
        text: { content: text },
      },
    })
  }

  private send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
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

/**
 * Delegate to the shared channel→agent bridge.
 *
 * Previously each bot carried its own 40-line copy that looked for `type: 'block'` — a shape
 * the server never emits — so every channel answered "No response" while the agent actually
 * ran. Parsing, event names and chunk buffering now live in exactly one place.
 */
async function callAgent(userText: string): Promise<string> {
  const reply = await callAgentBridge({ userText })
  if (reply.error) return `⚠️ ${reply.error}`
  return reply.text || 'No response'
}

// ── 公开 API（与 gateway.ts 接入） ─────────────────────

/** 测试连接：建 WS → 订阅 → 等待 ack（最多 5s），返回订阅结果 */
export async function testWecomConnection(botId: string, secret: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { ws.close() } catch {}; resolve({ ok: false, error: '订阅超时（5s），请检查网络或凭据' }) }
    }, 5000)

    const ws = new WebSocket(WECOM_WS_URL)
    const deviceId = randomUUID().replace(/-/g, '')
    const reqId = newReqId('test')

    ws.on('open', () => {
      ws.send(JSON.stringify({
        cmd: CMD_SUBSCRIBE,
        headers: { req_id: reqId },
        body: { bot_id: botId, secret, device_id: deviceId },
      }))
    })

    ws.on('message', (data: Buffer) => {
      try {
        const payload: WecomPayload = JSON.parse(data.toString())
        if (payload.cmd === CMD_PING) return
        if (payload.headers?.req_id !== reqId) return
        const errcode = payload.errcode ?? payload.body?.errcode ?? 0
        if (errcode === 0 || errcode == null) {
          if (!settled) { settled = true; clearTimeout(timer); try { ws.close() } catch {}; resolve({ ok: true }) }
        } else {
          if (!settled) { settled = true; clearTimeout(timer); try { ws.close() } catch {}; resolve({ ok: false, error: payload.errmsg || payload.body?.errmsg || `errcode=${errcode}` }) }
        }
      } catch { /* 忽略解析失败 */ }
    })

    ws.on('error', (err: Error) => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: err.message }) }
    })

    ws.on('close', () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: '连接被关闭' }) }
    })
  })
}

export async function startWecomChannel(channelId: string): Promise<boolean> {
  const db = getDB()
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND platform = ?')
    .get(channelId, 'wecom') as any

  if (!channel) {
    console.error(`[企微] 通道不存在: ${channelId}`)
    return false
  }

  const existing = activeBots.get(channelId)
  if (existing) {
    await existing.stop()
  }

  const parsedConfig: WecomChannelConfig = {
    id: channel.id,
    name: channel.name,
    config: JSON.parse(channel.config || '{}'),
  }

  if (!parsedConfig.config.botId || !parsedConfig.config.secret) {
    console.error(`[企微] 配置不完整（缺少 Bot ID/Secret）: ${channelId}`)
    return false
  }

  const bot = new WecomBotInstance(parsedConfig)
  activeBots.set(channelId, bot)
  const ok = await bot.start()
  if (!ok) activeBots.delete(channelId)
  return ok
}

export async function stopWecomChannel(channelId: string): Promise<boolean> {
  const bot = activeBots.get(channelId)
  if (!bot) return false
  await bot.stop()
  activeBots.delete(channelId)
  return true
}

export async function startAllWecomChannels() {
  const db = getDB()
  const channels = db.prepare(
    "SELECT * FROM channels WHERE platform = 'wecom' AND enabled = 1"
  ).all() as any[]

  for (const ch of channels) {
    console.log(`[企微] 🚀 启动通道: ${ch.name} (${ch.id})`)
    await startWecomChannel(ch.id)
  }
}

export async function stopAllWecomChannels() {
  for (const [id, bot] of activeBots) {
    await bot.stop()
  }
  activeBots.clear()
}

export function getWecomChannelStatus(channelId: string): 'connected' | 'disconnected' | 'error' | 'not_found' {
  const bot = activeBots.get(channelId)
  if (!bot) return 'not_found'
  return 'connected'
}
