/**
 * Telegram Bot 长轮询服务
 * 接入 Telegram 官方 Bot API（getUpdates 长轮询，无需公网回调，无需 webhook）
 *
 * 设计要点（参考 Hermes agent 的 telegram 插件工程经验）：
 *  1. 长轮询：HTTP outbound 连接，本地/内网环境即可运行，无需公网回调
 *  2. 网络兜底：api.telegram.org 在中国大陆可能被 DNS 污染/直连超时，
 *     支持 TELEGRAM_API_BASE 覆盖为反代地址（如 https://tg.xxx.com/bot 或本地 telegram-bot-api server）
 *  3. 长消息聚合：Telegram 客户端会把超长消息拆成多条 update，按 chat 缓冲合并
 *  4. 分段发送：单条 4096 字符上限，超长回复自动分段
 *  5. 白名单：私聊可选 allowedUserIds；群聊仅响应 @bot 提及
 *
 * 文档: https://core.telegram.org/bots/api
 */
import { callAgent as callAgentBridge } from './agent-bridge'
import { getDB } from '../services/database'
import { formatForChannel } from '../services/channel-format'

// ── 类型定义 ──────────────────────────────────────────

interface TelegramChannelConfig {
  id: string
  name: string
  config: {
    botToken: string
    allowedUserIds?: string
    baseUrl?: string
  }
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
}

interface TelegramMessage {
  message_id: number
  chat: { id: number; type: string; username?: string; first_name?: string; title?: string }
  from?: { id: number; is_bot?: boolean; username?: string; first_name?: string }
  text?: string
  caption?: string
  date: number
  entities?: Array<{ type: string; offset: number; length: number }>
  photo?: any[]
  voice?: any
  audio?: any
  document?: any
}

// ── 常量 ──────────────────────────────────────────────

const TG_API_DEFAULT = 'https://api.telegram.org/bot'
const POLL_TIMEOUT = 30 // getUpdates 长轮询秒数
const MAX_SEND = 4000 // Telegram 单条消息上限 4096，留余量
const BATCH_WINDOW_MS = 700 // 长消息聚合窗口

// ── 状态管理 ──────────────────────────────────────────

const activeBots = new Map<string, TelegramBotInstance>()

// ── 工具函数 ──────────────────────────────────────────

function tgUrl(token: string, method: string, baseUrl?: string): string {
  const base = (baseUrl || TG_API_DEFAULT).replace(/\/+$/, '')
  return `${base}${token}/${method}`
}

/** 调用 Telegram Bot API（带超时与错误归一） */
async function tgCall(
  token: string,
  method: string,
  params: Record<string, any> = {},
  baseUrl?: string,
  timeoutMs = 20000,
): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const r = await fetch(tgUrl(token, method, baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    })
    const data = await r.json() as any
    if (!r.ok || data.ok === false) {
      throw new Error(`Telegram API ${method} 失败: ${data.description || r.status}`)
    }
    return data.result
  } finally {
    clearTimeout(timer)
  }
}

/** 验证 token 有效性（getMe），用于网关页"测试连接" */
export async function testTelegramToken(
  botToken: string,
  baseUrl?: string,
): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const result = await tgCall(botToken, 'getMe', {}, baseUrl, 10000)
    return { ok: true, username: result.username }
  } catch (err: any) {
    return { ok: false, error: err.message }
  }
}

/** 从 Telegram update 中提取消息文本（text 或 caption） */
function extractText(msg: TelegramMessage): string {
  return msg.text || msg.caption || ''
}

/** 判断消息是否 @ 了本 bot（entities 中 mention/mention 指向 bot username） */
function isMentioned(msg: TelegramMessage, botUsername: string | null): boolean {
  if (!msg.entities?.length || !botUsername) return false
  for (const e of msg.entities) {
    if (e.type === 'mention' && msg.text) {
      const mention = msg.text.slice(e.offset, e.offset + e.length).replace(/^@/, '').toLowerCase()
      if (mention === botUsername.toLowerCase()) return true
    }
    if (e.type === 'bot_command') return true // 群聊中 /command 视为触发
  }
  return false
}

/** 从群聊消息中剥离 @bot 提及，只留正文 */
function stripMention(msg: TelegramMessage, botUsername: string | null): string {
  let text = msg.text || ''
  if (botUsername) {
    text = text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim()
  }
  return text
}

/** 判断消息是否应处理：私聊全处理；群聊仅 @bot 或命令触发 */
function shouldProcess(msg: TelegramMessage, botUsername: string | null, allowList: Set<number> | null): boolean {
  if (msg.from?.is_bot) return false // 忽略 bot 消息
  if (msg.chat.type === 'private') {
    if (allowList && allowList.size > 0) return allowList.has(msg.from?.id || -1)
    return true
  }
  // 群聊 / 超级群
  return isMentioned(msg, botUsername) || !!msg.entities?.some(e => e.type === 'bot_command')
}

// ── Bot 实例 ──────────────────────────────────────────

class TelegramBotInstance {
  private config: TelegramChannelConfig
  private token = ''
  private baseUrl?: string
  private botUsername: string | null = null
  private offset = 0
  private running = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private failCount = 0
  private maxReconnect = 10
  private allowList: Set<number> | null = null
  private pendingBatches = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>()
  private lastChatId: string | null = null

  /** 获取最后交互的 chat_id（主动推送用） */
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
      console.error(`[Telegram] 主动推送失败: ${err.message}`)
      return false
    }
  }

  constructor(config: TelegramChannelConfig) {
    this.config = config
  }

  async start(): Promise<boolean> {
    if (this.running) return true
    try {
      this.token = this.config.config.botToken
      this.baseUrl = this.config.config.baseUrl || undefined
      // 白名单（逗号分隔的用户 ID）
      const allowRaw = this.config.config.allowedUserIds?.trim()
      this.allowList = allowRaw ? new Set(allowRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n))) : null
      // 启动前验证 token + 获取 bot username（@提及判断需要）
      const me = await tgCall(this.token, 'getMe', {}, this.baseUrl, 10000)
      this.botUsername = me.username || null
      console.log(`[Telegram] ✅ Bot @${this.botUsername} 连接成功 (${this.config.name})`)
      this.running = true
      this.failCount = 0
      void this.pollLoop()
      this.updateDBStatus('connected')
      return true
    } catch (err: any) {
      console.error(`[Telegram] ❌ 启动失败: ${err.message}`)
      this.running = false
      this.updateDBStatus('error')
      return false
    }
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null }
    // 清空聚合缓冲
    for (const { timer } of this.pendingBatches.values()) clearTimeout(timer)
    this.pendingBatches.clear()
    this.updateDBStatus('disconnected')
    console.log(`[Telegram] ⏹️ 已停止 (${this.config.name})`)
  }

  /** getUpdates 长轮询主循环 */
  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const params: Record<string, any> = {
          timeout: POLL_TIMEOUT,
          offset: this.offset,
          allowed_updates: ['message'],
        }
        const updates = await tgCall(this.token, 'getUpdates', params, this.baseUrl, POLL_TIMEOUT * 1000 + 15000)
        this.failCount = 0
        for (const u of updates as TelegramUpdate[]) {
          this.offset = u.update_id + 1
          if (u.message) this.handleMessage(u.message).catch(err => {
            console.error(`[Telegram] 消息处理失败: ${err.message}`)
          })
        }
      } catch (err: any) {
        this.failCount++
        // 409 冲突 = 另一个实例在轮询，属于配置错误，不重试
        if (String(err.message).includes('409')) {
          console.error(`[Telegram] ❌ 409 冲突：同一 token 已被另一实例轮询，停止`)
          this.running = false
          this.updateDBStatus('error')
          return
        }
        console.error(`[Telegram] 轮询错误 (${this.failCount}/${this.maxReconnect}): ${err.message}`)
        if (this.failCount > this.maxReconnect) {
          console.error(`[Telegram] ❌ 连续失败超过 ${this.maxReconnect} 次，停止`)
          this.running = false
          this.updateDBStatus('error')
          return
        }
        const delay = this.failCount > 3 ? 30000 : 2000
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  /** 处理单条消息：聚合 → 转发 agent → 分段回发 */
  private async handleMessage(msg: TelegramMessage): Promise<void> {
    if (!shouldProcess(msg, this.botUsername, this.allowList)) return

    const chatId = String(msg.chat.id)
    this.lastChatId = chatId
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup'

    // 群聊：剥离 @bot 提及
    let text = extractText(msg)
    if (isGroup) text = stripMention(msg, this.botUsername)

    if (!text.trim()) return

    // 媒体消息处理（照片/语音/文件）：降级为文本描述
    if (msg.photo?.length) text = `${text ? text + '\n' : ''}[图片消息]`.trim()
    else if (msg.voice) text = `${text ? text + '\n' : ''}[语音消息]`.trim()
    else if (msg.audio) text = `${text ? text + '\n' : ''}[音频消息]`.trim()
    else if (msg.document) text = `${text ? text + '\n' : ''}[文件消息: ${msg.document.file_name || '未知'}]`.trim()

    console.log(`[Telegram] ${msg.chat.type === 'private' ? '私聊' : '群聊'} [${msg.from?.username || msg.from?.first_name || msg.from?.id}]: ${text.slice(0, 60)}`)

    // 长消息聚合：Telegram 会拆分超长消息为多条 update
    const key = `${chatId}:${msg.from?.id}`
    const existing = this.pendingBatches.get(key)
    if (existing) {
      clearTimeout(existing.timer)
      existing.text += text
      existing.timer = setTimeout(() => this.dispatchBatch(key, chatId, existing.text), BATCH_WINDOW_MS)
      return
    }
    this.pendingBatches.set(key, {
      text,
      timer: setTimeout(() => {
        const batch = this.pendingBatches.get(key)
        if (batch) { this.pendingBatches.delete(key); this.dispatchBatch(key, chatId, batch.text) }
      }, BATCH_WINDOW_MS),
    })
  }

  /** 聚合完成后统一转发 agent 并回发 */
  private async dispatchBatch(key: string, chatId: string, text: string): Promise<void> {
    void key
    try {
      // 发送"正在输入"状态
      this.sendTyping(chatId).catch(() => {})

      const reply = await callAgent(text)
      if (!reply) return

      await this.sendChunked(chatId, formatForChannel(reply, 'telegram'))
      console.log(`[Telegram] 回复已发送 (${reply.length} chars)`)
    } catch (err: any) {
      console.error(`[Telegram] agent 调用失败: ${err.message}`)
    }
  }

  private async sendTyping(chatId: string): Promise<void> {
    await tgCall(this.token, 'sendChatAction', { chat_id: chatId, action: 'typing' }, this.baseUrl, 10000).catch(() => {})
  }

  /** 分段发送（单条 ≤ 4000 字符） */
  private async sendChunked(chatId: string, text: string): Promise<void> {
    if (text.length <= MAX_SEND) {
      await this.sendSafe(chatId, text)
      return
    }
    const chunks: string[] = []
    for (let i = 0; i < text.length; i += MAX_SEND) {
      chunks.push(text.slice(i, i + MAX_SEND))
    }
    for (let i = 0; i < chunks.length; i++) {
      const prefix = i === 0 ? '' : `\n(${i + 1}/${chunks.length})\n`
      await this.sendSafe(chatId, prefix + chunks[i])
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 400))
    }
  }

  private async sendSafe(chatId: string, text: string): Promise<void> {
    try {
      await tgCall(this.token, 'sendMessage', { chat_id: chatId, text }, this.baseUrl, 30000)
    } catch (err: any) {
      // 失败时降级重试：Markdown 特殊字符可能被 Telegram 解析报错，去掉 parse_mode 用纯文本重发
      console.warn(`[Telegram] 发送失败，降级纯文本重试: ${err.message}`)
      await tgCall(this.token, 'sendMessage', { chat_id: chatId, text: text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&') }, this.baseUrl, 30000)
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

export async function startTelegramChannel(channelId: string): Promise<boolean> {
  const db = getDB()
  const channel = db.prepare('SELECT * FROM channels WHERE id = ? AND platform = ?')
    .get(channelId, 'telegram') as any

  if (!channel) {
    console.error(`[Telegram] 通道不存在: ${channelId}`)
    return false
  }

  const existing = activeBots.get(channelId)
  if (existing) {
    await existing.stop()
  }

  const parsedConfig: TelegramChannelConfig = {
    id: channel.id,
    name: channel.name,
    config: JSON.parse(channel.config || '{}'),
  }

  if (!parsedConfig.config.botToken) {
    console.error(`[Telegram] 配置不完整（缺少 botToken）: ${channelId}`)
    return false
  }

  const bot = new TelegramBotInstance(parsedConfig)
  activeBots.set(channelId, bot)
  const ok = await bot.start()
  if (!ok) activeBots.delete(channelId)
  return ok
}

export async function stopTelegramChannel(channelId: string): Promise<boolean> {
  const bot = activeBots.get(channelId)
  if (!bot) return false
  await bot.stop()
  activeBots.delete(channelId)
  return true
}

export async function startAllTelegramChannels() {
  const db = getDB()
  const channels = db.prepare(
    "SELECT * FROM channels WHERE platform = 'telegram' AND enabled = 1"
  ).all() as any[]

  for (const ch of channels) {
    console.log(`[Telegram] 🚀 启动通道: ${ch.name} (${ch.id})`)
    await startTelegramChannel(ch.id)
  }
}

export async function stopAllTelegramChannels() {
  for (const [id, bot] of activeBots) {
    await bot.stop()
  }
  activeBots.clear()
}

export function getTelegramChannelStatus(channelId: string): 'connected' | 'disconnected' | 'error' | 'not_found' {
  const bot = activeBots.get(channelId)
  if (!bot) return 'not_found'
  return 'connected'
}

/** 获取运行中的 bot 实例（notifier 主动推送用），无实例返回 null */
export function getTelegramBot(channelId: string): { sendActive: (text: string) => Promise<boolean> } | null {
  const bot = activeBots.get(channelId)
  if (!bot || !bot.getLastChatId()) return null
  return { sendActive: (t) => bot.sendActive(t) }
}
