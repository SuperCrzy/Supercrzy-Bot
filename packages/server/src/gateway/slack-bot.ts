/**
 * Slack Bot 服务
 * 接入 Slack Socket Mode（WebSocket 免公网回调）+ chat.postMessage 回复
 * 支持私聊 DM 与群聊 @提及，消息转发 SUPERCRZY agent
 *
 * 文档: https://api.slack.com/apis/connections/socket
 */
import WebSocket from 'ws'
import { getDB } from '../services/database'
import { formatForChannel } from '../services/channel-format'

// ── 类型定义 ──────────────────────────────────────────

interface SlackChannelConfig {
  id: string
  name: string
  config: {
    botToken: string    // xoxb-... 用于 chat.postMessage
    appToken: string    // xapp-... 用于 Socket Mode 连接
    allowedUserIds?: string
  }
}

// ── 常量 ──────────────────────────────────────────────

const SLACK_API = 'https://slack.com/api'

// ── 状态管理 ──────────────────────────────────────────

const activeBots = new Map<string, SlackBotInstance>()

// ── 工具函数 ──────────────────────────────────────────

/** 调用 Slack Web API（form 或 json） */
async function slackCall(
  token: string,
  method: string,
  params: Record<string, any> = {},
  useForm = false,
  timeoutMs = 20000,
): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    let body: string | undefined
    if (useForm) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(params as Record<string, string>).toString()
    } else {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(params)
    }
    const r = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok || data.ok === false) {
      throw new Error(`Slack API ${method} 失败: ${data.error || r.status}`)
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

/** 验证 token 有效性：apps.connections.open 拿 wss URL 即证明 xapp 有效 */
export async function testSlackTokens(botToken: string, appToken: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await slackCall(appToken, 'apps.connections.open', {}, true, 10000)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

/** 从 Slack 消息文本中剥掉 <@U123> 提及 */
function extractText(text: string): string {
  return (text || '').replace(/<@U\w+>/g, '').replace(/<#[CGA]\w+>/g, '').trim()
}

/** 判断消息是否应处理：DM 全处理（可选白名单）；群聊需 @bot */
function shouldProcess(ev: any, botUserId: string, allowList: Set<string> | null): boolean {
  const user = ev.user
  if (!user || user === botUserId) return false // 忽略 bot 自己
  if (ev.subtype && ev.subtype !== 'bot_message') {
    // 消息变更/删除等忽略
    if (['message_changed', 'message_deleted', 'message_replied'].includes(ev.subtype)) return false
  }
  if (!ev.channel_type) return false
  if (ev.channel_type === 'im') { // DM
    if (allowList && allowList.size > 0) return allowList.has(user)
    return true
  }
  // 群聊：@bot 提及才响应（text 含 <@BOTID>）
  return ev.text?.includes(`<@${botUserId}>`) || false
}

// ── Bot 实例 ──────────────────────────────────────────

class SlackBotInstance {
  private config: SlackChannelConfig
  private ws: WebSocket | null = null
  private running = false
  private reconnectAttempts = 0
  private maxReconnect = 10
  private botUserId = ''
  private allowList: Set<string> | null = null
  private lastChatId: string | null = null

  /** 获取最后交互的 channel（主动推送用） */
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
      console.error(`[Slack] 主动推送失败: ${err.message}`)
      return false
    }
  }

  constructor(config: SlackChannelConfig) {
    this.config = config
  }

  async start(): Promise<boolean> {
    if (this.running) return true
    try {
      const allowRaw = this.config.config.allowedUserIds?.trim()
      this.allowList = allowRaw ? new Set(allowRaw.split(',').map(s => s.trim()).filter(Boolean)) : null

      // 验证 token + 获取 bot 自身 ID
      const auth = await slackCall(this.config.config.botToken, 'auth.test', {}, true, 10000)
      this.botUserId = auth.user_id || ''
      console.log(`[Slack] ✅ Bot @${auth.user || auth.user_id} 连接成功 (${this.config.name})`)

      this.running = true
      this.reconnectAttempts = 0
      void this.connect()
      this.updateDBStatus('connected')
      return true
    } catch (err: any) {
      console.error(`[Slack] ❌ 启动失败: ${err.message}`)
      this.running = false
      this.updateDBStatus('error')
      return false
    }
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.ws) {
      try { this.ws.close(1000) } catch {}
      this.ws = null
    }
    this.updateDBStatus('disconnected')
    console.log(`[Slack] ⏹️ 已停止 (${this.config.name})`)
  }

  private async connect() {
    if (!this.running) return
    try {
      // 1. 拿动态 wss URL
      const resp = await slackCall(this.config.config.appToken, 'apps.connections.open', {}, true, 10000)
      const url = resp.url
      if (!url) throw new Error('apps.connections.open 未返回 wss URL')
      console.log(`[Slack] 🔗 连接 Socket Mode: ${url.slice(0, 60)}...`)

      // 2. WebSocket 连接
      this.ws = new WebSocket(url)

      this.ws.on('open', () => {
        console.log(`[Slack] 🔌 Socket 已连接`)
      })

      this.ws.on('message', (data: Buffer) => {
        try {
          const payload = JSON.parse(data.toString())
          this.handlePayload(payload).catch(err => {
            console.error(`[Slack] 事件处理失败: ${err.message}`)
          })
        } catch (err) {
          console.error('[Slack] 消息解析失败:', err)
        }
      })

      this.ws.on('close', (code: number) => {
        console.log(`[Slack] ⚠️ Socket 关闭 (code=${code})`)
        this.ws = null
        if (this.running && this.reconnectAttempts < this.maxReconnect) {
          const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
          this.reconnectAttempts++
          console.log(`[Slack] 🔄 ${delay / 1000}s 后重连 (第${this.reconnectAttempts}次)...`)
          setTimeout(() => this.connect(), delay)
        }
      })

      this.ws.on('error', (err: Error) => {
        console.error(`[Slack] WebSocket 错误: ${err.message}`)
      })
    } catch (err: any) {
      console.error(`[Slack] 连接失败: ${err.message}`)
      if (this.running) {
        this.reconnectAttempts++
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000)
        setTimeout(() => this.connect(), delay)
      }
    }
  }

  private async handlePayload(payload: any) {
    // Socket Mode 所有事件都需 ACK（回传 envelope_id）
    if (payload.envelope_id) {
      this.send({ envelope_id: payload.envelope_id })
    }

    switch (payload.type) {
      case 'hello':
        this.reconnectAttempts = 0
        console.log(`[Slack] ✅ Hello`)
        break
      case 'events_api': {
        const ev = payload.payload?.event || {}
        if (ev.type === 'message') {
          await this.handleMessage(ev)
        }
        break
      }
      case 'disconnect':
        console.log(`[Slack] 服务端要求断开: ${payload.reason || ''}`)
        if (this.ws) this.ws.close(1000)
        break
      default:
        break
    }
  }

  private send(data: any) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private async handleMessage(ev: any) {
    if (!shouldProcess(ev, this.botUserId, this.allowList)) return
    const text = extractText(ev.text)
    if (!text) return

    this.lastChatId = ev.channel || null
    const isDM = ev.channel_type === 'im'
    console.log(`[Slack] ${isDM ? 'DM' : '群聊'} [${ev.user}]: ${text.slice(0, 60)}`)

    try {
      const reply = await callAgent(text)
      if (!reply) return
      await this.sendChunked(ev.channel, formatForChannel(reply, 'slack'))
      console.log(`[Slack] 回复已发送 (${reply.length} chars)`)
    } catch (err: any) {
      console.error(`[Slack] agent 调用失败: ${err.message}`)
    }
  }

  /** 分段发送（Slack 单条 40000 字符，但聊天建议 ≤ 4000 保可读性） */
  private async sendChunked(channel: string, text: string): Promise<void> {
    const MAX = 3800
    if (text.length <= MAX) {
      await this.postMessage(channel, text)
      return
    }
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += MAX) {
      chunks.push(text.slice(i, i + MAX))
    }
    for (let i = 0; i < chunks.length; i++) {
      const prefix = i === 0 ? '' : `\n(${i + 1}/${chunks.length})\n`
      await this.postMessage(channel, prefix + chunks[i])
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 400))
    }
  }

  private async postMessage(channel: string, content: string): Promise<void> {
    await slackCall(this.config.config.botToken, 'chat.postMessage', {
      channel,
      text: content,
      mrkdwn: false, // 避免 markdown 语法冲突
    }, true, 30000)
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

export async function startSlackChannel(channelId: string): Promise<boolean> {
  const db = getDB()
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND platform = ?')
    .get(channelId, 'slack') as any

  if (!channel) {
    console.error(`[Slack] 通道不存在: ${channelId}`)
    return false
  }

  const existing = activeBots.get(channelId)
  if (existing) {
    await existing.stop()
  }

  const parsedConfig: SlackChannelConfig = {
    id: channel.id,
    name: channel.name,
    config: JSON.parse(channel.config || '{}'),
  }

  if (!parsedConfig.config.botToken || !parsedConfig.config.appToken) {
    console.error(`[Slack] 配置不完整（缺少 Bot Token 或 App Token）: ${channelId}`)
    return false
  }

  const bot = new SlackBotInstance(parsedConfig)
  activeBots.set(channelId, bot)
  const ok = await bot.start()
  if (!ok) activeBots.delete(channelId)
  return ok
}

export async function stopSlackChannel(channelId: string): Promise<boolean> {
  const bot = activeBots.get(channelId)
  if (!bot) return false
  await bot.stop()
  activeBots.delete(channelId)
  return true
}

export async function startAllSlackChannels() {
  const db = getDB()
  const channels = db.prepare(
    "SELECT * FROM channels WHERE platform = 'slack' AND enabled = 1"
  ).all() as any[]

  for (const ch of channels) {
    console.log(`[Slack] 🚀 启动通道: ${ch.name} (${ch.id})`)
    await startSlackChannel(ch.id)
  }
}

export async function stopAllSlackChannels() {
  for (const [id, bot] of activeBots) {
    await bot.stop()
  }
  activeBots.clear()
}

export function getSlackChannelStatus(channelId: string): 'connected' | 'disconnected' | 'error' | 'not_found' {
  const bot = activeBots.get(channelId)
  if (!bot) return 'not_found'
  return 'connected'
}

/** 获取运行中的 bot 实例（notifier 主动推送用），无实例返回 null */
export function getSlackBot(channelId: string): { sendActive: (text: string) => Promise<boolean> } | null {
  const bot = activeBots.get(channelId)
  if (!bot || !bot.getLastChatId()) return null
  return { sendActive: (t) => bot.sendActive(t) }
}
