import { describe, expect, it } from 'vitest'
import { channelSessionId } from './channel-session-id'

describe('channel session identity', () => {
  it('is stable while separating formerly colliding user IDs', () => {
    const first = channelSessionId('wechat', 'bot', 'user/a', 'user/a')
    expect(channelSessionId('wechat', 'bot', 'user/a', 'user/a')).toBe(first)
    expect(channelSessionId('wechat', 'bot', 'user?a', 'user?a')).not.toBe(first)
    expect(channelSessionId('wechat', 'bot', 'a'.repeat(32) + 'x', 'a'.repeat(32) + 'x'))
      .not.toBe(channelSessionId('wechat', 'bot', 'a'.repeat(32) + 'y', 'a'.repeat(32) + 'y'))
  })
  it('separates bots, platforms and group conversations', () => {
    const baseline = channelSessionId('qq', 'bot-a', 'group-a', 'user')
    for (const alternative of [
      channelSessionId('qq', 'bot-b', 'group-a', 'user'),
      channelSessionId('qq', 'bot-a', 'group-b', 'user'),
      channelSessionId('qq', 'bot-a', 'group-a', 'other'),
      channelSessionId('wechat', 'bot-a', 'group-a', 'user'),
    ]) expect(alternative).not.toBe(baseline)
  })
  it('fails closed when a required identity is absent', () => {
    expect(() => channelSessionId('qq', 'bot', '', 'user')).toThrow('channel_identity_missing')
  })
})
