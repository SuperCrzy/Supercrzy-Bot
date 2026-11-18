import { describe, expect, it, vi } from 'vitest'
import { QQBotClient } from './qqbot-client'

describe('QQ gateway identity mapping', () => {
  it.each([
    ['C2C_MESSAGE_CREATE', { author: { user_openid: 'direct-user' } }, 'direct-user'],
    ['GROUP_AT_MESSAGE_CREATE', { author: { member_openid: 'group-member' }, group_openid: 'group' }, 'group-member'],
    ['AT_MESSAGE_CREATE', { author: { id: 'channel-user' }, channel_id: 'channel' }, 'channel-user'],
    ['DIRECT_MESSAGE_CREATE', { author: { id: 'dm-user' }, guild_id: 'guild' }, 'dm-user'],
  ])('maps the sender of %s', (event, payload, expected) => {
    const client = new QQBotClient({ appId: 'bot', appSecret: 'test', intents: 0 })
    const listener = vi.fn()
    client.on('message', listener)
    ;(client as any).handleEvent(event, { ...payload, id: 'message', content: 'hello' }, 'event')
    expect(listener).toHaveBeenCalledWith(event, expect.objectContaining({ id: 'message', author: expect.objectContaining({ id: expected }) }))
  })
  it('does not confuse group and direct-message identity fields', () => {
    const client = new QQBotClient({ appId: 'bot', appSecret: 'test', intents: 0 })
    const listener = vi.fn()
    client.on('message', listener)
    ;(client as any).handleEvent('GROUP_AT_MESSAGE_CREATE', { author: { user_openid: 'direct-only' }, group_openid: 'group' }, 'event')
    expect(listener.mock.calls[0][1].author.id).toBe('')
  })
})
