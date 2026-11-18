import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { handleChannelMessageOnce, wechatMessageId } from './channel-message-dedup'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('channel message deduplication', () => {
  it('runs an ID only once, including across a reopened database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'channel-receipts-'))
    const path = join(dir, 'db.sqlite')
    let db = new Database(path)
    const run = vi.fn(async () => 'done')
    expect(await handleChannelMessageOnce(db, 'session', 'message', run)).toEqual({ duplicate: false, value: 'done' })
    db.close()
    db = new Database(path)
    expect(await handleChannelMessageOnce(db, 'session', 'message', run)).toEqual({ duplicate: true })
    expect(await handleChannelMessageOnce(db, 'other', 'message', run)).toEqual({ duplicate: false, value: 'done' })
    expect(run).toHaveBeenCalledTimes(2)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  it('keeps a failed or interrupted reservation rather than replaying side effects', async () => {
    const db = new Database(':memory:')
    const run = vi.fn(async () => { throw new Error('after side effect') })
    await expect(handleChannelMessageOnce(db, 's', 'id', run)).rejects.toThrow('after side effect')
    expect(await handleChannelMessageOnce(db, 's', 'id', run)).toEqual({ duplicate: true })
    db.prepare("UPDATE channel_message_receipts SET status = 'reserved'").run()
    expect(await handleChannelMessageOnce(db, 's', 'id', run)).toEqual({ duplicate: true })
    expect(run).toHaveBeenCalledTimes(1)
    db.close()
  })
  it('does not claim deduplication when no reliable ID exists', async () => {
    expect(wechatMessageId({ message_id: Number.MAX_SAFE_INTEGER + 1, msg_id: 'safe-id' })).toBe('msg_id:safe-id')
    expect(wechatMessageId({ client_id: 'possibly-a-device-id' })).toBeUndefined()
    expect(wechatMessageId({ message_id: '0', svr_id: '42' })).toBe('svr_id:42')
    expect(wechatMessageId({ message_id: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined()
    const db = new Database(':memory:')
    const run = vi.fn(async () => 'ok')
    await handleChannelMessageOnce(db, 's', undefined, run)
    await handleChannelMessageOnce(db, 's', undefined, run)
    expect(run).toHaveBeenCalledTimes(2)
    db.close()
  })
})
