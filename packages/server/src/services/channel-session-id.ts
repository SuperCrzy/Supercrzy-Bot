import { createHash } from 'node:crypto'

/** Stable opaque namespace for platform, bot, conversation and sender. */
export function channelSessionId(platform: 'wechat' | 'qq', botId: string, conversationId: string, senderId: string): string {
  if (!botId || !conversationId || !senderId) throw new Error('channel_identity_missing')
  const digest = createHash('sha256').update(JSON.stringify([platform, botId, conversationId, senderId])).digest('hex')
  return `${platform}-${digest}`
}
