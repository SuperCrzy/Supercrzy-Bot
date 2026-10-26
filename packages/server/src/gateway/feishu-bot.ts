/**
 * 飞书 Bot 服务（长连接模式）
 * 使用官方 @larksuiteoapi/node-sdk 的 WSClient（WebSocket 长连接，免公网回调）
 * 订阅 im.message.receive_v1 事件，回复走 im/v1/messages API
 *
 * 文档: https://open.feishu.cn/document/server-docs/event-subscription-guide/
 */
import { callAgent as callAgentBridge } from './agent-bridge'
import Lark from '@larksuiteoapi/node-sdk'
import { formatForChannel } from '../services/channel-format'
import { getDB } from '../services/database'

// ── 类型定义 ──────────────────────────────────────────

interface FeishuChannelConfig {
  id: string
  name: string
  config: {
    appId: string
    appSecret: string
    allowedUserIds?: string
  }
}

// ── 状态管理 ──────────────────────────────────────────

const activeBots = new Map<string, FeishuBotInstance>()

// ── 工具函数 ──────────────────────────────────────────

/** 验证 appId/appSecret（请求 tenant token 即验证） */
export async function testFeishuCreds(appId: string, appSecret: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new Lark.Client({ appId, appSecret, appType: Lark.AppType.SelfBuild })
    await client.auth.tenantAccessToken.internal({
      data: { app_id: appId, app_secret: appSecret },
    })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

/** 从飞书消息 content JSON 提取文本 */
function extractText(msg: any): string {
  try {
    const content = JSON.parse(msg?.content || '{}')
    return (content.text || '').trim()
  } catch {
    return ''
  }
}

/** 判断是否应处理：p2p 单聊全处理（可选白名单）；群聊需 @机器人 */
function shouldProcess(event: any, allowList: Set<string> | null): boolean {
  const chatType = event.message?.chat_type || ''
  const senderId = event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || ''
  if (chatType === 'p2p') {
    if (allowList && allowList.size > 0) return allowList.has(senderId)
    return true
  }
  // 群聊：需 @机器人（mention 包含自己）——简化：飞书群聊默认需 @，用 mentions 判断
  const mentions = event.message?.mentions || []
  return mentions.length > 0
}

// ── Bot 实例 ──────────────────────────────────────────

class FeishuBotInstance {
  private config: FeishuChannelConfig
  private client: Lark.Client | null = null
  private wsClient: Lark.WSClient | null = null
  private running = false
  private allowList: Set<string> | null = null
  private lastChatId: string | null = null

  /** 获取最后交互的 chat_id（主动推送用） */
  getLastChatId(): string | null {
    return this.lastChatId
  }

  /** 主动发送消息（notifier 推送用） */
  async sendActive(text: string): Promise<boolean> {
    if (!this.lastChatId) return false
    try {
      await this.sendText(this.lastChatId, text)
      return true
    } catch (err: any) {
      console.error(`[飞书] 主动推送失败: ${err.message}`)
      return false
    }
  }

  constructor(config: FeishuChannelConfig) {
    this.config = config
  }

  async start(): Promise<boolean> {
    if (this.running) return true
    try {
      const allowRaw = this.config.config.allowedUserIds?.trim()
      this.allowList = allowRaw ? new Set(allowRaw.split(',').map(s => s.trim()).filter(Boolean)) : null

      // 先验证凭据
      await testFeishuCreds(this.config.config.appId, this.config.config.appSecret)
      console.log(`[飞书] ✅ 凭据验证通过 (${this.config.name})`)

      this.client = new Lark.Client({
        appId: this.config.config.appId,
        appSecret: this.config.config.appSecret,
        appType: Lark.AppType.SelfBuild,
      })

      // 启动长连接 WSClient
      this.wsClient = new Lark.WSClient({
        appId: this.config.config.appId,
        appSecret: this.config.config.appSecret,
        loggerLevel: Lark.LoggerLevel.error,
      })

      const dispatcher = new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: any) => {
          // 长连接需 3s 内处理完，否则触发超时重推——先快速 ACK（不抛异常即 ACK）
          const event = data.event
          this.handleMessage(event).catch(err => {
            console.error(`[飞书] 消息处理失败: ${err.message}`)
          })
        },
      })

      this.running = true
      void this.wsClient.start({ eventDispatcher: dispatcher })
      this.updateDBStatus('connected')
      return true
    } catch (err: any) {
      console.error(`[飞书] ❌ 启动失败: ${err.message}`)
      this.running = false
      this.updateDBStatus('error')
      return false
    }
  }

  async stop(): Promise<void> {
    this.running = false
    try {
      await this.wsClient?.close()
    } catch {}
    this.wsClient = null
    this.updateDBStatus('disconnected')
    console.log(`[飞书] ⏹️ 已停止 (${this.config.name})`)
  }

  private async handleMessage(event: any) {
    if (!shouldProcess(event, this.allowList)) return
    const text = extractText(event.message)
    if (!text) return

    const chatId = event.message?.chat_id || ''
    this.lastChatId = chatId || null
    const senderName = event.sender?.sender_id?.open_id || 'unknown'
    const isGroup = event.message?.chat_type === 'group'
    console.log(`[飞书] ${isGroup ? '群聊' : '单聊'} [${senderName}]: ${text.slice(0, 60)}`)

    try {
      const reply = await callAgent(text)
      if (!reply) return
      await this.sendText(chatId, formatForChannel(reply, 'feishu'))
      console.log(`[飞书] 回复已发送 (${reply.length} chars)`)
    } catch (err: any) {
      console.error(`[飞书] agent 调用失败: ${err.message}`)
    }
  }

  /** 通过 im/v1/messages 发送文本（单条上限大，分段 18000） */
  private async sendText(chatId: string, text: string): Promise<void> {
    const MAX = 18000
    if (text.length <= MAX) {
      await this.postMessage(chatId, text)
      return
    }
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += MAX) {
      chunks.push(text.slice(i, i + MAX))
    }
    for (let i = 0; i < chunks.length; i++) {
      const prefix = i === 0 ? '' : `\n(${i + 1}/${chunks.length})\n`
      await this.postMessage(chatId, prefix + chunks[i])
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 400))
    }
  }

  private async postMessage(chatId: string, content: string): Promise<void> {
    if (!this.client) return
    await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      },
    })
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

export async function startFeishuChannel(channelId: string): Promise<boolean> {
  const db = getDB()
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND platform = ?')
    .get(channelId, 'feishu') as any

  if (!channel) {
    console.error(`[飞书] 通道不存在: ${channelId}`)
    return false
  }

  const existing = activeBots.get(channelId)
  if (existing) {
    await existing.stop()
  }

  const parsedConfig: FeishuChannelConfig = {
    id: channel.id,
    name: channel.name,
    config: JSON.parse(channel.config || '{}'),
  }

  if (!parsedConfig.config.appId || !parsedConfig.config.appSecret) {
    console.error(`[飞书] 配置不完整（缺少 App ID/Secret）: ${channelId}`)
    return false
  }

  const bot = new FeishuBotInstance(parsedConfig)
  activeBots.set(channelId, bot)
  const ok = await bot.start()
  if (!ok) activeBots.delete(channelId)
  return ok
}

export async function stopFeishuChannel(channelId: string): Promise<boolean> {
  const bot = activeBots.get(channelId)
  if (!bot) return false
  await bot.stop()
  activeBots.delete(channelId)
  return true
}

export async function startAllFeishuChannels() {
  const db = getDB()
  const channels = db.prepare(
    "SELECT * FROM channels WHERE platform = 'feishu' AND enabled = 1"
  ).all() as any[]

  for (const ch of channels) {
    console.log(`[飞书] 🚀 启动通道: ${ch.name} (${ch.id})`)
    await startFeishuChannel(ch.id)
  }
}

export async function stopAllFeishuChannels() {
  for (const [id, bot] of activeBots) {
    await bot.stop()
  }
  activeBots.clear()
}

export function getFeishuChannelStatus(channelId: string): 'connected' | 'disconnected' | 'error' | 'not_found' {
  const bot = activeBots.get(channelId)
  if (!bot) return 'not_found'
  return 'connected'
}

/** 获取运行中的 bot 实例（notifier 主动推送用），无实例返回 null */
export function getFeishuBot(channelId: string): { sendActive: (text: string) => Promise<boolean> } | null {
  const bot = activeBots.get(channelId)
  if (!bot || !bot.getLastChatId()) return null
  return { sendActive: (t) => bot.sendActive(t) }
}
