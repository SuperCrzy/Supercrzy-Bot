import Router from 'koa-router'
import type { Context } from 'koa'
import { v4 as uuidv4 } from 'uuid'
import { getDB } from '../services/database'
import { upsertWorkspace } from './workspace'

export const sessionRouter = new Router({ prefix: '/api/sessions' })

// List sessions（归档过滤：默认只列未归档，?archived=1 列归档区，?archived=all 全部）
sessionRouter.get('/', (ctx: Context) => {
  const db = getDB()
  const q = String((ctx.query.archived as string) || '0')
  let sessions: Array<any>
  if (q === 'all') {
    sessions = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as Array<any>
  } else {
    sessions = db.prepare('SELECT * FROM sessions WHERE archived = ? ORDER BY updated_at DESC').all(Number(q)) as Array<any>
  }
  ctx.body = sessions
})

// Get session with messages
sessionRouter.get('/:id', (ctx: Context) => {
  const db = getDB()
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(ctx.params.id) as any
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  const messages = db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(ctx.params.id) as Array<any>
  // Parse attachments JSON for each message
  for (const msg of messages) {
    if (msg.attachments) {
      try {
        msg.attachments = JSON.parse(msg.attachments)
      } catch {
        msg.attachments = []
      }
    } else {
      msg.attachments = []
    }
  }
  ctx.body = { ...session, messages }
})

// 会话产物列表：AI 在该会话生成/修改的文件（按时间倒序）
sessionRouter.get('/:id/artifacts', (ctx: Context) => {
  const db = getDB()
  const artifacts = db
    .prepare('SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(ctx.params.id) as Array<any>
  ctx.body = artifacts
})

// 会话产物内容（文本类文件预览）
sessionRouter.get('/:id/artifacts/:artifactId/content', async (ctx: Context) => {
  const db = getDB()
  const art = db.prepare('SELECT * FROM artifacts WHERE id = ? AND session_id = ?').get(ctx.params.artifactId, ctx.params.id) as any
  if (!art) {
    ctx.status = 404
    ctx.body = { error: 'Artifact not found' }
    return
  }
  try {
    const { readFile } = await import('fs/promises')
    const content = await readFile(art.path, 'utf-8')
    ctx.body = { name: art.name, path: art.path, content: content.slice(0, 100000) }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: `读取文件失败: ${err.message}` }
  }
})

// 会话产物直出：HTML/图片等浏览器直接渲染打开，PPT/文档等触发下载
sessionRouter.get('/:id/artifacts/:artifactId/file', async (ctx: Context) => {
  const db = getDB()
  const art = db.prepare('SELECT * FROM artifacts WHERE id = ? AND session_id = ?').get(ctx.params.artifactId, ctx.params.id) as any
  if (!art) {
    ctx.status = 404
    ctx.body = { error: 'Artifact not found' }
    return
  }
  try {
    const { readFile } = await import('fs/promises')
    const data = await readFile(art.path)
    ctx.status = 200
    ctx.set('Content-Type', art.mime || 'application/octet-stream')
    // 浏览器能内联渲染的类型直接打开；其余（pptx/docx 等）下载
    const inlineTypes = ['text/', 'image/', 'application/javascript', 'application/json', 'application/xml']
    const inline = inlineTypes.some((t) => (art.mime || '').startsWith(t))
    ctx.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(art.name)}"`)
    ctx.body = data
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: `读取文件失败: ${err.message}` }
  }
})

// 打开本地产物：直接调用系统默认程序（PPT→Keynote/PowerPoint、文档→对应软件），
// reveal=true 时在文件管理器中显示所在文件夹。产物在本机生成，无需重新下载。
sessionRouter.post('/:id/artifacts/:artifactId/open', async (ctx: Context) => {
  const db = getDB()
  const art = db.prepare('SELECT * FROM artifacts WHERE id = ? AND session_id = ?').get(ctx.params.artifactId, ctx.params.id) as any
  if (!art) {
    ctx.status = 404
    ctx.body = { error: 'Artifact not found' }
    return
  }
  const reveal = !!(ctx.request.body as any)?.reveal
  try {
    const { existsSync } = await import('fs')
    if (!existsSync(art.path)) {
      ctx.status = 404
      ctx.body = { error: '文件不存在（可能已被移动或删除）' }
      return
    }
    const { execFile } = await import('child_process')
    const isWin = process.platform === 'win32'
    const cmd = isWin ? (reveal ? 'explorer' : 'start') : 'open'
    const args = isWin
      ? reveal ? ['/select,', art.path] : [art.path]
      : reveal ? ['-R', art.path] : [art.path]
    await new Promise<void>((resolve, reject) => {
      execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
    })
    ctx.body = { success: true, opened: art.path, reveal }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: `打开失败: ${err.message}` }
  }
})

// Create session
sessionRouter.post('/', (ctx: Context) => {
  const db = getDB()
  const body = ctx.request.body as { id?: string; title?: string; model?: string; workspace_dir?: string; permission_level?: string; collab_mode?: string }
  // 接受前端传入的 ID，没有则自动生成
  const id = body.id || uuidv4()
  const ws = (body.workspace_dir || '').trim()
  const level = ['workspace-only', 'sandbox', 'full'].includes(body.permission_level || '')
    ? body.permission_level
    : 'sandbox'
  // 超级协作平台：'semi'|'senate' 标记为协作任务会话，null=普通对话
  const collab = body.collab_mode === 'semi' || body.collab_mode === 'senate' ? body.collab_mode : null
  db.prepare('INSERT INTO sessions (id, title, model, workspace_dir, permission_level, collab_mode) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    body.title || 'New Chat',
    body.model || 'deepseek-v4-pro',
    ws,
    level,
    collab
  )
  // 工作区索引：创建会话时记录（upsertWorkspace 内部处理空路径）
  upsertWorkspace(ws)
  ctx.body = { id, title: body.title || 'New Chat', model: body.model || 'deepseek-v4-pro', workspace_dir: ws, permission_level: level, collab_mode: collab }
  ctx.status = 201
})

// Update session
sessionRouter.patch('/:id', (ctx: Context) => {
  const db = getDB()
  const body = ctx.request.body as { title?: string; model?: string; workspace_dir?: string; permission_level?: string; archived?: boolean }
  if (body.title) {
    db.prepare("UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?")
      .run(body.title, ctx.params.id)
  }
  if (body.model) {
    db.prepare("UPDATE sessions SET model = ?, updated_at = datetime('now') WHERE id = ?")
      .run(body.model, ctx.params.id)
  }
  if (body.workspace_dir !== undefined) {
    db.prepare("UPDATE sessions SET workspace_dir = ?, updated_at = datetime('now') WHERE id = ?")
      .run((body.workspace_dir || '').trim(), ctx.params.id)
  }
  if (body.permission_level !== undefined && ['workspace-only', 'sandbox', 'full'].includes(body.permission_level)) {
    db.prepare("UPDATE sessions SET permission_level = ?, updated_at = datetime('now') WHERE id = ?")
      .run(body.permission_level, ctx.params.id)
  }
  if (body.archived !== undefined) {
    db.prepare('UPDATE sessions SET archived = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(body.archived ? 1 : 0, ctx.params.id)
  }
  ctx.body = { success: true }
})

// Delete session
sessionRouter.delete('/:id', (ctx: Context) => {
  const db = getDB()
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(ctx.params.id)
  if (result.changes === 0) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }
  ctx.body = { success: true }
})

// Delete message from session（消息操作栏"删除"）
sessionRouter.delete('/:id/messages/:msgId', (ctx: Context) => {
  const db = getDB()
  const result = db.prepare('DELETE FROM messages WHERE id = ? AND session_id = ?').run(ctx.params.msgId, ctx.params.id)
  if (result.changes === 0) {
    ctx.status = 404
    ctx.body = { error: 'Message not found' }
    return
  }
  ctx.body = { success: true }
})

// 批量作废分支：删除指定消息及其之后的所有消息（编辑/重生成时旧分支作废，对齐 GPT regenerate 分支语义）
// DELETE /api/sessions/:id/messages?after=msgId
sessionRouter.delete('/:id/messages', (ctx: Context) => {
  const db = getDB()
  const after = String((ctx.query.after as string) || '')
  if (!after) {
    ctx.status = 400
    ctx.body = { error: 'after is required' }
    return
  }
  const row = db.prepare('SELECT created_at, id FROM messages WHERE id = ? AND session_id = ?').get(after, ctx.params.id) as any
  if (!row) {
    ctx.status = 404
    ctx.body = { error: 'Message not found' }
    return
  }
  // 按 created_at 排序，删除 >= 目标消息序号之后的全部消息（含目标）
  db.prepare(
    'DELETE FROM messages WHERE session_id = ? AND id IN (SELECT id FROM messages WHERE session_id = ? AND (created_at > ? OR (created_at = ? AND id >= ?)))',
  ).run(ctx.params.id, ctx.params.id, row.created_at, row.created_at, after)
  ctx.body = { success: true }
})

// 消息反馈（点赞/点踩持久化）：feedback = 'up' | 'down' | null（取消）
sessionRouter.post('/messages/:msgId/feedback', (ctx: Context) => {
  const { feedback } = (ctx.request.body as any) || {}
  if (!['up', 'down', null, ''].includes(feedback)) {
    ctx.status = 400
    ctx.body = { error: 'feedback must be up|down|null' }
    return
  }
  const db = getDB()
  const value = feedback || null
  const result = db.prepare('UPDATE messages SET feedback = ? WHERE id = ?').run(value, ctx.params.msgId)
  if (result.changes === 0) {
    ctx.status = 404
    ctx.body = { error: 'Message not found' }
    return
  }
  ctx.body = { ok: true, feedback: value }
})

// Add message to session (幂等：用 INSERT OR REPLACE 支持重复调用)
sessionRouter.post('/:id/messages', (ctx: Context) => {
  const db = getDB()
  const body = ctx.request.body as {
    id?: string
    role: string
    content: string
    token_count?: number
    cost?: number
    elapsed_ms?: number
    attachments?: Array<{ id: string; name: string; type: string; size: number; url: string; thumbnailUrl?: string }>
  }

  if (!body.role || body.content === undefined) {
    ctx.status = 400
    ctx.body = { error: 'role and content are required' }
    return
  }

  const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(ctx.params.id)
  if (!session) {
    ctx.status = 404
    ctx.body = { error: 'Session not found' }
    return
  }

  // 接受前端传入的 ID，没有则自动生成
  const id = body.id || uuidv4()
  const attachmentsJson = body.attachments ? JSON.stringify(body.attachments) : null

  // 检查消息是否已存在（幂等）
  const existing = db.prepare('SELECT id FROM messages WHERE id = ?').get(id)
  if (existing) {
    // 更新已有消息内容
    db.prepare(
      'UPDATE messages SET content = ?, token_count = ?, cost = ?, elapsed_ms = ?, attachments = ?, created_at = datetime(\'now\') WHERE id = ?'
    ).run(body.content, body.token_count || null, body.cost || null, body.elapsed_ms || null, attachmentsJson, id)
  } else {
    db.prepare(
      'INSERT INTO messages (id, session_id, role, content, token_count, cost, elapsed_ms, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id, ctx.params.id, body.role, body.content, body.token_count || null, body.cost || null, body.elapsed_ms || null, attachmentsJson)
  }

  // Update session timestamp
  db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(ctx.params.id)

  ctx.body = { id, ...body }
  ctx.status = 201
})
