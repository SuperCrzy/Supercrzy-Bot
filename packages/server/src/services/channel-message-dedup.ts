import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

/** Preserve task IDs after failures: retrying a delivered command can repeat side effects. */
export async function handleChannelMessageOnce<T>(db: Database.Database, sessionId: string, messageId: unknown, run: () => Promise<T>): Promise<{ duplicate: boolean; value?: T }> {
  const id = typeof messageId === 'string' ? messageId : typeof messageId === 'number' && Number.isSafeInteger(messageId) ? String(messageId) : ''
  if (!id) return { duplicate: false, value: await run() }
  const digest = createHash('sha256').update(JSON.stringify([sessionId, id])).digest('hex')
  db.exec(`CREATE TABLE IF NOT EXISTS channel_message_receipts (
    message_key TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  const inserted = db.prepare("INSERT OR IGNORE INTO channel_message_receipts (message_key, status) VALUES (?, 'reserved')").run(digest)
  if (!inserted.changes) return { duplicate: true }
  try {
    const value = await run()
    db.prepare("UPDATE channel_message_receipts SET status = 'handled' WHERE message_key = ?").run(digest)
    return { duplicate: false, value }
  } catch (error) {
    db.prepare("UPDATE channel_message_receipts SET status = 'failed' WHERE message_key = ?").run(digest)
    throw error
  }
}

export function wechatMessageId(msg: { message_id?: unknown; msg_id?: unknown; svr_id?: unknown; client_id?: unknown }): string | undefined {
  // client_id is not documented here as a unique message ID; reusing a device
  // identifier as one could silently discard legitimate later messages.
  for (const [field, id] of [['message_id', msg.message_id], ['msg_id', msg.msg_id], ['svr_id', msg.svr_id]] as const) {
    if (typeof id === 'string' && id && id !== '0') return `${field}:${id}`
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return `${field}:${id}`
  }
  return undefined
}
