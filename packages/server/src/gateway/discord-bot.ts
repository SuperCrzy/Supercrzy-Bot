/**
 * Discord Bot 服务
 * 接入 Discord Bot API v10（WebSocket Gateway + REST）
 * 支持私聊 DM 与群聊 @提及，消息转发 SUPERCRZY agent
 *
 * 文档: https://discord.com/developers/docs/intro
 */
import WebSocket from 'ws'
import { getDB } from '../services/database'
import { formatForChannel } from '../services/channel-format'

// ── 类型定义 ──────────────────────────────────────────

interface DiscordChannelConfig {
  id: string
  name: string
  config: {
    botToken: string
    allowedUserIds?: string
  }
}

interface DiscordWSPayload {
  op: number
  d?: any
  s?: number
  t?: string
}

// ── 常量 ──────────────────────────────────────────────

const DISCORD_API = 'https://discord.com/api/v10'
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'

// Gateway Intents
// GUILDS(1<<0) | GUILD_MESSAGES(1<<9) | DIRECT_MESSAGES(1<<12) | MESSAGE_CONTENT(1<<15)
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)

// ── 状态管理 ──────────────────────────────────────────

const activeBots = new Map<string, DiscordBotInstance>()

// ── 工具函数 ──────────────────────────────────────────

/** 调用 Discord REST API */
async function discordCall(
  token: string,
  method: string,
  path: string,
  body?: any,
  timeoutMs = 20000,
): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await fetch(`${DISCORD_API}${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    if (r.status === 204) return null
    const data = await r.json().catch(() => null)
    if (!r.ok) {
      throw new Error(`Discord API ${path} 失败: ${r.status} ${data?.message || ''}`)
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

/** 验证 token 有效性（GET /users/@me） */
export async function testDiscordToken(botToken: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const me = await discordCall(botToken, 'GET', '/users/@me', undefined, 10000)
    return { ok: true, username: me.username }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

/** 从 Discord 消息中提取纯文本（剥掉 <@123> 提及与 markdown 噪音） */
function extractText(content: string): string {
  let t = content
  // 剥离 <@ID> / <@!ID> / <#ID> / <:emoji:ID>
  t = t.replace(/<@!?\d+>/g, '').replace(/<#\d+>/g, '').replace(/<a?:\w+:\d+>/g, '').trim()
  return t
}

/** 判断消息是否应处理：DM 全处理（可选白名单）；群聊仅 @bot */
function shouldProcess(d: any, botUserId: string, allowList: Set<string> | null): boolean {
  const author = d.author
  if (!author || author.bot) return false // 忽略 bot 消息
  if (d.channel_type === 1) { // DM
    if (allowList && allowList.size > 0) return allowList.has(author.id)
    return true
  }
  // 群聊：@bot 提及才响应
  return d.mentions?.some((m: any) => m.id === botUserId) || false
}

// ── Bot 实例 ──────────────────────────────────────────

class DiscordBotInstance {
  private config: DiscordChannelConfig
  private token = ''
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private seq: number | null = null
  private sessionId = ''
  private reconnectAttempts = 0
  private maxReconnect = 10
  private running = false
  private botUserId = ''
  private allowList: Set<string> | null = null
  private resumeUrl: string | null = null
  private lastChatId: string | null = null

  /** 获取最后交互的 channel_id（主动推送用） */
  getLastChatId(): string | null {
    return this.lastChatId
  }

  /** 主动发送消息（notifier 推送用） */
  async sendActive(text: string): Promise<boolean> {
    if (!this.lastChatId) return false
    try {
      await this.sendChunked(this.lastChatId, text)
      return true
    } catch (err: any) {
      console.error(`[Discord] 主动推送失败: ${err.message}`)
      return false
    }
  }

  constructor(config: DiscordChannelConfig) {
    this.config = config
  }

  async start(): Promise<boolean> {
    if (this.running) return true
    try {
      this.token = this.config.config.botToken
      const allowRaw = this.config.config.allowedUserIds?.trim()
      this.allowList = allowRaw ? new Set(allowRaw.split(',').map(s => s.trim()).filter(Boolean)) : null

      // 验证 token + 获取 bot 自身 ID
      const me = await discordCall(this.token, 'GET', '/users/@me', undefined, 10000)
      this.botUserId = me.id
      console.log(`[Discord] ✅ Bot @${me.username} (${me.id}) 连接成功 (${this.config.name})`)

      this.running = true
      this.reconnectAttempts = 0
      this.connect()
      this.updateDBStatus('connected')
      return true
    } catch (err: any) {
      console.error(`[Discord] ❌ 启动失败: ${err.message}`)
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
    console.log(`[Discord] ⏹️ 已停止 (${this.config.name})`)
  }

  private connect() {
    if (!this.running) return
    const url = this.resumeUrl || GATEWAY_URL
    console.log(`[Discord] 🔗 连接 Gateway: ${url}`)
    this.ws = new WebSocket(url)

    this.ws.on('open', () => {
      console.log(`[Discord] 🔌 Gateway 已连接`)
    })

    this.ws.on('message', (data: Buffer) => {
      try {
        const payload: DiscordWSPayload = JSON.parse(data.toString())
        if (payload.s) this.seq = payload.s
        this.handlePayload(payload).catch(err => {
          console.error(`[Discord] 事件处理失败: ${err.message}`)
        })
      } catch (err) {
        console.error('[Discord] 消息解析失败:', err)
      }
    })

    this.ws.on('close', (code: number) => {
      console.log(`[Discord] ⚠️ Gateway 关闭 (code=${code})`)
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
      this.ws = null
      this.updateDBStatus(this.running ? 'connected' : 'disconnected')

      if (this.running && this.reconnectAttempts < this.maxReconnect) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
        this.reconnectAttempts++
        console.log(`[Discord] 🔄 ${delay / 1000}s 后重连 (第${this.reconnectAttempts}次)...`)
        setTimeout(() => this.connect(), delay)
      }
    })

    this.ws.on('error', (err: Error) => {
      console.error(`[Discord] WebSocket 错误: ${err.message}`)
    })
  }

  private async handlePayload(payload: DiscordWSPayload) {
    switch (payload.op) {
      case 10: { // HELLO
        const interval = payload.d?.heartbeat_interval || 41250
        this.startHeartbeat(interval)
        // 若已有 sessionId 则 RESUME，否则 IDENTIFY
        if (this.sessionId && this.seq !== null) {
          this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } })
        } else {
          this.send({ op: 2, d: {
            token: this.token,
            intents: INTENTS,
            properties: { os: 'macOS', browser: 'SupercrzyBot', device: 'SupercrzyBot' },
          } })
        }
        break
      }
      case 0: // DISPATCH
        await this.handleEvent(payload.t || '', payload.d || {})
        break
      case 11: // HEARTBEAT ACK
        break
      case 9: { // INVALID SESSION
        console.log(`[Discord] Invalid session, canResume=${payload.d}`)
        if (payload.d === true && this.sessionId) {
          this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } })
        } else {
          this.sessionId = ''
          this.send({ op: 2, d: {
            token: this.token, intents: INTENTS,
            properties: { os: 'macOS', browser: 'SupercrzyBot', device: 'SupercrzyBot' },
          } })
        }
        break
      }
      case 7: // RECONNECT 请求
        console.log('[Discord] 服务端要求重连')
        if (this.ws) this.ws.close(1000)
        break
      case 1: // 服务端主动要求 HEARTBEAT
        this.send({ op: 1, d: this.seq })
        break
      default:
        break
    }
  }

  private startHeartbeat(interval: number) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ op: 1, d: this.seq })
      }
    }, interval)
  }

  private send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private async handleEvent(eventType: string, d: any) {
    switch (eventType) {
      case 'READY': {
        this.sessionId = d.session_id || ''
        this.reconnectAttempts = 0
        console.log(`[Discord] ✅ READY - session=${this.sessionId}, user=${d.user?.username}`)
        break
      }
      case 'RESUMED': {
        this.reconnectAttempts = 0
        console.log(`[Discord] ✅ RESUMED`)
        break
      }
      case 'MESSAGE_CREATE': {
        await this.handleMessage(d)
        break
      }
      default:
        break
    }
  }

  private async handleMessage(d: any) {
    if (!shouldProcess(d, this.botUserId, this.allowList)) return
    const text = extractText(d.content || '')
    if (!text) return

    this.lastChatId = d.channel_id || null
    const isDM = d.channel_type === 1
    const authorName = d.author?.username || d.author?.id || 'unknown'
    console.log(`[Discord] ${isDM ? 'DM' : '群聊'} [${authorName}]: ${text.slice(0, 60)}`)

    try {
      const reply = await callAgent(text)
      if (!reply) return
      await this.sendChunked(d.channel_id, formatForChannel(reply, 'discord'))
      console.log(`[Discord] 回复已发送 (${reply.length} chars)`)
    } catch (err: any) {
      console.error(`[Discord] agent 调用失败: ${err.message}`)
    }
  }

  /** 分段发送（Discord 单条 2000 字符上限） */
  private async sendChunked(channelId: string, text: string): Promise<void> {
    const MAX = 1900
    if (text.length <= MAX) {
      await this.sendMessage(channelId, text)
      return
    }
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += MAX) {
      chunks.push(text.slice(i, i + MAX))
    }
    for (let i = 0; i < chunks.length; i++) {
      const prefix = i === 0 ? '' : `\n(${i + 1}/${chunks.length})\n`
      await this.sendMessage(channelId, prefix + chunks[i])
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 400))
    }
  }

  private async sendMessage(channelId: string, content: string): Promise<void> {
    await discordCall(this.token, 'POST', `/channels/${channelId}/messages`, { content }, 30000)
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

export async function startDiscordChannel(channelId: string): Promise<boolean> {
  const db = getDB()
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND platform = ?')
    .get(channelId, 'discord') as any

  if (!channel) {
    console.error(`[Discord] 通道不存在: ${channelId}`)
    return false
  }

  const existing = activeBots.get(channelId)
  if (existing) {
    await existing.stop()
  }

  const parsedConfig: DiscordChannelConfig = {
    id: channel.id,
    name: channel.name,
    config: JSON.parse(channel.config || '{}'),
  }

  if (!parsedConfig.config.botToken) {
    console.error(`[Discord] 配置不完整（缺少 botToken）: ${channelId}`)
    return false
  }

  const bot = new DiscordBotInstance(parsedConfig)
  activeBots.set(channelId, bot)
  const ok = await bot.start()
  if (!ok) activeBots.delete(channelId)
  return ok
}

export async function stopDiscordChannel(channelId: string): Promise<boolean> {
  const bot = activeBots.get(channelId)
  if (!bot) return false
  await bot.stop()
  activeBots.delete(channelId)
  return true
}

export async function startAllDiscordChannels() {
  const db = getDB()
  const channels = db.prepare(
    "SELECT * FROM channels WHERE platform = 'discord' AND enabled = 1"
  ).all() as any[]

  for (const ch of channels) {
    console.log(`[Discord] 🚀 启动通道: ${ch.name} (${ch.id})`)
    await startDiscordChannel(ch.id)
  }
}

export async function stopAllDiscordChannels() {
  for (const [id, bot] of activeBots) {
    await bot.stop()
  }
  activeBots.clear()
}

export function getDiscordChannelStatus(channelId: string): 'connected' | 'disconnected' | 'error' | 'not_found' {
  const bot = activeBots.get(channelId)
  if (!bot) return 'not_found'
  return 'connected'
}

/** 获取运行中的 bot 实例（notifier 主动推送用），无实例返回 null */
export function getDiscordBot(channelId: string): { sendActive: (text: string) => Promise<boolean> } | null {
  const bot = activeBots.get(channelId)
  if (!bot || !bot.getLastChatId()) return null
  return { sendActive: (t) => bot.sendActive(t) }
}
