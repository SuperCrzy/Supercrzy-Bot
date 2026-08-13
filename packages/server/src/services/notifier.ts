/**
 * Notifier Service — 统一消息推送
 * 支持微信 iLink、QQ、Telegram、Discord、Slack、飞书 主动通知
 * 用于 automation 完成后推送结果给用户（推送到各渠道最后交互的会话）
 */
import { sendMessage, loadCredentials } from './wechat-ilink'
import { getLastWeChatUserId, getLastContextToken } from './wechat-bot-runner'
import { getDB } from './database'
import { getTelegramBot } from '../gateway/telegram-bot'
import { getDiscordBot } from '../gateway/discord-bot'
import { getSlackBot } from '../gateway/slack-bot'
import { getFeishuBot } from '../gateway/feishu-bot'

export type NotifyChannel = 'wechat' | 'qq' | 'telegram' | 'discord' | 'slack' | 'feishu' | 'all'

export interface NotifyResult {
  channel: NotifyChannel
  wechat: boolean
  qq: boolean
  telegram: boolean
  discord: boolean
  slack: boolean
  feishu: boolean
}

const emptyResult: NotifyResult = { channel: 'wechat', wechat: false, qq: false, telegram: false, discord: false, slack: false, feishu: false }

/** 解析 notify_channel 字符串 → 需要推送的渠道列表 */
function resolveTargets(channel: NotifyChannel | string): NotifyChannel[] {
  if (channel === 'all') return ['wechat', 'qq', 'telegram', 'discord', 'slack', 'feishu']
  return [channel as NotifyChannel]
}

/**
 * 发送通知到指定渠道
 * @param channel - 单渠道或 'all'（全部已配置渠道）
 * @param title   - 通知标题（加粗第一行）
 * @param body    - 通知正文
 */
export async function notify(
  channel: NotifyChannel,
  title: string,
  body: string
): Promise<NotifyResult> {
  const result = { ...emptyResult, channel }
  const message = `**${title}**\n\n${body}`

  const tasks: Promise<void>[] = []
  for (const target of resolveTargets(channel)) {
    if (target === 'wechat') {
      tasks.push(notifyWeChat(message).then(ok => { result.wechat = ok }))
    } else if (target === 'qq') {
      tasks.push(notifyQQ(message).then(ok => { result.qq = ok }))
    } else if (target === 'telegram') {
      tasks.push(notifyBotChannel('telegram', message).then(ok => { result.telegram = ok }))
    } else if (target === 'discord') {
      tasks.push(notifyBotChannel('discord', message).then(ok => { result.discord = ok }))
    } else if (target === 'slack') {
      tasks.push(notifyBotChannel('slack', message).then(ok => { result.slack = ok }))
    } else if (target === 'feishu') {
      tasks.push(notifyBotChannel('feishu', message).then(ok => { result.feishu = ok }))
    }
  }

  await Promise.allSettled(tasks)
  return result
}

/**
 * 通过渠道 bot 实例推送（Telegram/Discord/Slack/飞书）
 * 找到该渠道 enabled 且有最后交互会话的 bot 实例
 */
async function notifyBotChannel(platform: string, message: string): Promise<boolean> {
  try {
    const db = getDB()
    const channels = db.prepare(
      "SELECT id FROM channels WHERE platform = ? AND enabled = 1"
    ).all(platform) as { id: string }[]

    for (const ch of channels) {
      let bot: { sendActive: (t: string) => Promise<boolean> } | null = null
      if (platform === 'telegram') bot = getTelegramBot(ch.id)
      else if (platform === 'discord') bot = getDiscordBot(ch.id)
      else if (platform === 'slack') bot = getSlackBot(ch.id)
      else if (platform === 'feishu') bot = getFeishuBot(ch.id)

      if (bot) {
        const ok = await bot.sendActive(message)
        if (ok) {
          console.log(`[Notifier] ${platform} sent`)
          return true
        }
      }
    }
    console.log(`[Notifier] ${platform}: no active bot with recent conversation`)
    return false
  } catch (err: any) {
    console.error(`[Notifier] ${platform} failed:`, err.message)
    return false
  }
}

/** WeChat iLink 通知 */
async function notifyWeChat(message: string): Promise<boolean> {
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

    console.log(`[Notifier] WeChat sent to ${toUserId}`)
    return true
  } catch (err: any) {
    console.error('[Notifier] WeChat failed:', err.message)
    return false
  }
}

/** QQ Bot 通知 */
async function notifyQQ(message: string): Promise<boolean> {
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
