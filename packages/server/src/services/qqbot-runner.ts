/**
 * QQ Bot Runner — 消息处理、Agent 调用、回复发送
 */
import { QQBotClient, QQBotConfig, ensureToken, sendQQMessage, type QQMessageEvent, type QQEventType } from './qqbot-client'
import { getDB } from './database'
import { randomUUID } from 'crypto'
import { createPreviewLink } from './tunnel'

export interface QQBotRunnerConfig extends QQBotConfig {
  agentPort: number
}

export class QQBotRunner {
  private config: QQBotRunnerConfig
  private client: QQBotClient

  constructor(config: QQBotRunnerConfig) {
    this.config = config
    this.client = new QQBotClient(config)
  }

  /** 启动 Bot */
  async start(): Promise<void> {
    this.client.on('message', (type: QQEventType, msg: QQMessageEvent) => {
      this.handleMessage(type, msg)
    })

    await this.client.start()
  }

  /** 处理消息 → Agent → 回复 */
  private async handleMessage(type: QQEventType, msg: QQMessageEvent): Promise<void> {
    if (!msg.content?.trim()) return

    // 记录最后用户 openid，供 notifier 主动推送
    if (msg.author?.id) lastQQOpenId = msg.author.id

    try {
      const reply = await this.callAgent(msg.author.id, msg.content)
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

      console.log(`[QQBot] Reply sent to ${msg.author.id}: ${reply.slice(0, 60)}`)
    } catch (err: any) {
      console.error(`[QQBot] Handle error:`, err.message)
      try {
        await this.sendReply(type, msg, '出错了，请稍后再试')
      } catch {}
    }
  }

  /** 调用 SUPERCRZY Agent */
  private async callAgent(userId: string, text: string): Promise<string> {
    // 稳定 sessionId
    const sessionId = userId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)
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
    const res = await fetch(`http://localhost:${this.config.agentPort}/api/chat/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: apiMessages, model: 'deepseek-v4-pro' }),
    })
    if (!res.ok) return 'Agent is busy, try later.'

    const reader = res.body?.getReader()
    if (!reader) return ''

    const decoder = new TextDecoder()
    let buf = ''
    let result = ''
    let hasFile = false
    let filePath = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      for (const line of buf.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const d = JSON.parse(line.slice(6))
            if (d.content) result = d.content
            if (d.event === 'file_created' || d.path) { hasFile = true; filePath = d.path || filePath }
          } catch {}
        }
      }
      const nl = buf.lastIndexOf('\n')
      buf = nl >= 0 ? buf.slice(nl + 1) : buf
    }

    // 存 assistant 回复
    if (result) {
      const msgId = randomUUID()
      let fullResult = result
      if (hasFile && filePath) {
        const previewUrl = createPreviewLink(filePath)
        fullResult += `\n\n📁 ${filePath.split('/').pop()}\n🔗 ${previewUrl}`
      }
      db.prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)").run(
        msgId, sessionId, 'assistant', fullResult
      )
      return fullResult
    }

    return ''
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
