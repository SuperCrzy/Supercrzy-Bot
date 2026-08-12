/**
 * Notifier Service — 统一消息推送
 * 支持微信 iLink 主动通知（QQ 预留）
 * 用于 automation 完成后推送结果给用户
 */
import { sendMessage, loadCredentials } from './wechat-ilink'
import { getLastWeChatUserId, getLastContextToken } from './wechat-bot-runner'

export type NotifyChannel = 'wechat' | 'qq' | 'both'

export interface NotifyResult {
  channel: NotifyChannel
  wechat: boolean
  qq: boolean
}

/**
 * 发送通知到指定渠道
 * @param channel - 'wechat' | 'qq' | 'both'
 * @param title   - 通知标题（加粗第一行）
 * @param body    - 通知正文
 */
export async function notify(
  channel: NotifyChannel,
  title: string,
  body: string
): Promise<NotifyResult> {
  const result: NotifyResult = { channel, wechat: false, qq: false }

  const tasks: Promise<void>[] = []

  if (channel === 'wechat' || channel === 'both') {
    tasks.push(
      notifyWeChat(title, body).then(ok => { result.wechat = ok })
    )
  }

  if (channel === 'qq' || channel === 'both') {
    tasks.push(
      notifyQQ(title, body).then(ok => { result.qq = ok })
    )
  }

  await Promise.allSettled(tasks)
  return result
}

/** WeChat iLink 通知 */
async function notifyWeChat(title: string, body: string): Promise<boolean> {
  try {
    const creds = loadCredentials()
    if (!creds) {
      console.log('[Notifier] WeChat: no credentials loaded')
      return false
    }

    const toUserId = getLastWeChatUserId()
    if (!toUserId) {
      console.log('[Notifier] WeChat: no target user (no messages received yet)')
      return false
    }

    const contextToken = getLastContextToken() || ''
    const message = `**${title}**\n\n${body}`

    // 分段发送（微信单条 ≤ 2000 字符）
    const CHUNK = 1800
    if (message.length <= CHUNK) {
      await sendMessage(creds.baseUrl, creds.token, toUserId, message, contextToken)
    } else {
      const chunks: string[] = []
      for (let i = 0; i < message.length; i += CHUNK) {
        chunks.push(message.slice(i, i + CHUNK))
      }
      for (let i = 0; i < chunks.length; i++) {
        const prefix = i === 0 ? '' : `\n(${i + 1}/${chunks.length})\n`
        await sendMessage(creds.baseUrl, creds.token, toUserId, prefix + chunks[i], contextToken)
        if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 400))
      }
    }

    console.log(`[Notifier] WeChat sent to ${toUserId}: ${title}`)
    return true
  } catch (err: any) {
    console.error('[Notifier] WeChat failed:', err.message)
    return false
  }
}

/** QQ Bot 通知（预留） */
async function notifyQQ(title: string, body: string): Promise<boolean> {
  try {
    const appId = process.env.QQ_APPID
    const appSecret = process.env.QQ_APPSECRET

    if (!appId || !appSecret) {
      console.log('[Notifier] QQ: not configured')
      return false
    }

    // 获取 access token
    const tokenResp = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret: appSecret }),
    })

    if (!tokenResp.ok) {
      console.error('[Notifier] QQ: token fetch failed')
      return false
    }

    const { access_token } = await tokenResp.json() as { access_token?: string }
    if (!access_token) {
      console.error('[Notifier] QQ: no access_token')
      return false
    }

    // 从 QQ Bot Runner 获取最后用户 openid
    const { getLastQQOpenId } = await import('./qqbot-runner')
    const openid = getLastQQOpenId()
    if (!openid) {
      console.log('[Notifier] QQ: no target user')
      return false
    }

    const { sendQQMessage } = await import('./qqbot-client')
    const message = `${title}\n\n${body}`
    await sendQQMessage(access_token, {
      msg_type: 0,
      content: message,
      openid,
    })

    console.log(`[Notifier] QQ sent to ${openid}`)
    return true
  } catch (err: any) {
    console.error('[Notifier] QQ failed:', err.message)
    return false
  }
}
