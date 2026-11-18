/**
 * QQ Bot Runner — 消息处理、Agent 调用、回复发送
 */
import { QQBotClient, QQBotConfig, ensureToken, sendQQMessage, type QQMessageEvent, type QQEventType } from './qqbot-client'
import { getDB } from './database'
import { randomUUID } from 'crypto'
import { createPreviewLink } from './tunnel'
import { channelSessionId } from './channel-session-id'
import { readWechatAgentStream } from './wechat-agent-stream'
import { KeyedTaskQueue } from './keyed-task-queue'
import { handleChannelMessageOnce } from './channel-message-dedup'

export interface QQBotRunnerConfig extends QQBotConfig {
  agentPort: number
}

export class QQBotRunner {
  private config: QQBotRunnerConfig
  private client: QQBotClient
  private readonly messageQueue = new KeyedTaskQueue()

  constructor(config: QQBotRunnerConfig) {
    this.config = config
    this.client = new QQBotClient(config)
  }

  /** 启动 Bot */
  async start(): Promise<void> {
    this.client.on('message', (type: QQEventType, msg: QQMessageEvent) => {
      const conversation = type === 'GROUP_AT_MESSAGE_CREATE' ? msg.group_openid : type === 'AT_MESSAGE_CREATE' ? msg.channel_id : msg.author?.id
      if (!conversation || !msg.author?.id) return
      const key = channelSessionId('qq', this.config.appId, conversation, msg.author.id)
      void this.messageQueue.run(key, () => handleChannelMessageOnce(getDB(), key, msg.id, () => this.handleMessage(type, msg))).catch((error) => {
        if (error instanceof Error && error.message === 'channel_queue_full') {
          void this.sendReply(type, msg, '待处理消息过多，请稍后再发送。').catch(() => {})
        } else console.error('[QQBot] Message processing failed')
      })
    })

    await this.client.start()
  }

  /** 处理消息 → Agent → 回复 */
  private async handleMessage(type: QQEventType, msg: QQMessageEvent): Promise<void> {
    if (!msg.content?.trim() || !msg.author?.id) return

    // 记录最后用户 openid，供 notifier 主动推送
    if (msg.author?.id) lastQQOpenId = msg.author.id

    try {
      const conversation = type === 'GROUP_AT_MESSAGE_CREATE' ? msg.group_openid : type === 'AT_MESSAGE_CREATE' ? msg.channel_id : msg.author.id
      if (!conversation) throw new Error('channel_identity_missing')
      const reply = await this.callAgent(msg.author.id, msg.content, conversation)
      if (!reply) {
        await this.sendReply(type, msg, '暂时无法处理，请稍后再试')
        return
      }

      // 分片发送（QQ 消息长度限制约 4000 字符）
      if (reply.length > 3800) {
        for (let i = 0; i < reply.length; i += 3800) {
          const chunk = reply.slice(i, i + 3800)
          await this.sendReply(type, msg, chunk)
          if (reply.length > 3800) await sleep(500)
        }
      } else {
        await this.sendReply(type, msg, reply)
      }

      console.log('[QQBot] Reply sent')
    } catch (err: any) {
      console.error(`[QQBot] Handle error:`, err.message)
      try {
        await this.sendReply(type, msg, '任务未确认完成，请在电脑端检查执行状态。')
      } catch {}
    }
  }

  /** 调用 SUPERCRZY BOT */
  private async callAgent(userId: string, text: string, conversationId: string): Promise<string> {
    // 稳定 sessionId
    const sessionId = channelSessionId('qq', this.config.appId, conversationId, userId)
    const db = getDB()

    // 确保 session 存在
    const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)
    if (!existing) {
      db.prepare("INSERT INTO sessions (id, title, model) VALUES (?, ?, ?)").run(
        sessionId, `QQ: ${userId.slice(0, 12)}...`, 'deepseek-v4-pro'
      )
    }

    // 存用户消息
    const userMsgId = randomUUID()
    db.prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)").run(
      userMsgId, sessionId, 'user', text
    )

    // 查历史
    const history = db.prepare(
      "SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 30"
    ).all(sessionId) as Array<{ role: string; content: string }>
    const apiMessages = history.reverse().map(m => ({ role: m.role, content: m.content }))

    // 调 Agent
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 480_000)
    try {
    const res = await fetch(`http://127.0.0.1:${this.config.agentPort}/api/chat/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: apiMessages, model: 'deepseek-v4-pro', sessionId }),
      signal: controller.signal,
    })
    if (!res.ok) return '任务未确认完成，请在电脑端检查执行状态。'
    if (!res.body) throw new Error('agent_stream_missing')
    const stream = await readWechatAgentStream(res.body, controller)
    const result = stream.completed ? (stream.text || '任务已完成，无文字输出。') : [stream.text, '任务未确认完成，请在电脑端检查执行状态。'].filter(Boolean).join('\n\n')

    // 存 assistant 回复
    if (result) {
      const msgId = randomUUID()
      let fullResult = result
      if (stream.filePath) {
        const previewUrl = createPreviewLink(stream.filePath)
        fullResult += `\n\n📁 ${stream.filePath.split('/').pop()}\n🔗 ${previewUrl}`
      }
      db.prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)").run(
        msgId, sessionId, 'assistant', fullResult
      )
      return fullResult
    }

    return ''
    } finally { clearTimeout(timeout) }
  }

  /** 发送回复 */
  private async sendReply(type: QQEventType, msg: QQMessageEvent, content: string): Promise<void> {
    const token = await ensureToken(this.config)

    // 移除消息中可能包含的本地文件路径
    const cleanContent = content.replace(/\/Users\/[^\s]+\/[^\s]+/g, (m) => m.split('/').pop() || m)

    if (type === 'C2C_MESSAGE_CREATE') {
      await sendQQMessage(token, {
        msg_type: 0, content: cleanContent,
        openid: msg.author.id, msg_id: msg.id,
      })
    } else if (type === 'GROUP_AT_MESSAGE_CREATE') {
      await sendQQMessage(token, {
        msg_type: 0, content: cleanContent,
        group_openid: msg.group_openid, msg_id: msg.id,
      })
    } else if (type === 'AT_MESSAGE_CREATE' && msg.channel_id) {
      await sendQQMessage(token, {
        msg_type: 0, content: cleanContent,
        channel_id: msg.channel_id, msg_id: msg.id,
      })
    } else if (type === 'DIRECT_MESSAGE_CREATE' && msg.guild_id) {
      await sendQQMessage(token, {
        msg_type: 0, content: cleanContent,
        guild_id: msg.guild_id, msg_id: msg.id,
      })
    }
  }

  /** 停止 Bot */
  stop(): void {
    this.client.stop()
  }
}

// ── Notifier 导出: 记录最后 QQ 用户 openid，供 scheduler 主动推送 ──
let lastQQOpenId = ''

export function getLastQQOpenId(): string {
  return lastQQOpenId
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
