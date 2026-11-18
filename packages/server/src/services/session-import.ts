import type Database from 'better-sqlite3'

/** Import a complete new session in one transaction; never modify local rows. */
export function importCloudSession(db: Database.Database, input: unknown): 'created' | 'exists' {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_session')
  const s = input as Record<string, unknown>
  const validText = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max
  if (!validText(s.id, 200) || !validText(s.title, 1000) || !validText(s.model, 200) || !validText(s.createdAt, 64) || !validText(s.updatedAt, 64) || !Array.isArray(s.messages) || s.messages.length > 10000) throw new Error('invalid_session')
  if (s.archived !== undefined && typeof s.archived !== 'boolean') throw new Error('invalid_session')
  const messages = s.messages as Array<Record<string, unknown>>
  const seen = new Set<string>()
  for (const m of messages) {
    if (!m || typeof m !== 'object' || !validText(m.id, 200) || !['user', 'assistant', 'system'].includes(String(m.role)) || typeof m.content !== 'string' || m.content.length > 1_000_000 || !validText(m.createdAt, 64) || seen.has(m.id as string)) throw new Error('invalid_message')
    if (m.attachments != null && (typeof m.attachments !== 'object' || JSON.stringify(m.attachments).length > 1_000_000)) throw new Error('invalid_message')
    seen.add(m.id as string)
  }
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(s.id)) return 'exists' as const
    const insertMessage = db.prepare('INSERT INTO messages (id, session_id, role, content, created_at, attachments) VALUES (?, ?, ?, ?, ?, ?)')
    db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at, archived) VALUES (?, ?, ?, ?, ?, ?)').run(s.id, s.title, s.model, s.createdAt, s.updatedAt, s.archived ? 1 : 0)
    for (const m of messages) insertMessage.run(m.id, s.id, m.role, m.content, m.createdAt, m.attachments == null ? null : JSON.stringify(m.attachments))
    return 'created' as const
  }).immediate()
}
