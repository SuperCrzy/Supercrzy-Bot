import Router from 'koa-router'
import type { Context } from 'koa'
import { v4 as uuidv4 } from 'uuid'
import { existsSync, mkdirSync, unlinkSync, createReadStream, readFileSync } from 'fs'
import { join, extname, basename } from 'path'
import { getDB } from '../services/database'
import multer from '@koa/multer'
import { config } from '../config'

export const uploadRouter = new Router({ prefix: '/api/upload' })

// Ensure upload directory exists
const UPLOAD_DIR = join(process.cwd(), 'uploads')
if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR, { recursive: true })
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR)
  },
  filename: (req, file, cb) => {
    const ext = extname(file.originalname) || ''
    const uniqueName = `${uuidv4()}${ext}`
    cb(null, uniqueName)
  },
})

// File filter: allow images, PDF, Word, Excel, plain text, code files
function fileFilter(_req: any, file: Express.Multer.File, cb: (error: Error | null, acceptFile: boolean) => void) {
  // 放宽为全类型可传（老板 2026-08-25：上传文件不限制类型；图片/文档/视频/音频/任意格式）
  cb(null, true)
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
    files: 5, // max 5 files per request
  },
})

// Upload endpoint
uploadRouter.post('/', async (ctx, next) => {
  try { await next() } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === 'LIMIT_FILE_SIZE') {
      ctx.status = 413
      ctx.body = { code, error: '单个文件不能超过 20 MB' }
    } else if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_UNEXPECTED_FILE') {
      ctx.status = 400
      ctx.body = { code: 'LIMIT_FILE_COUNT', error: '每次最多上传 5 个文件' }
    } else throw error
  }
}, upload.array('files', 5), async (ctx: Context) => {
  const files = ctx.files as Express.Multer.File[] | undefined

  if (!files || files.length === 0) {
    ctx.status = 400
    ctx.body = { error: '没有文件上传', code: 'NO_FILE' }
    return
  }

  const sessionId = (ctx.request.body as any)?.session_id || null

  try {
    const db = getDB()
    const save = db.transaction(() => files.map((file) => {
    const fileId = uuidv4()
    const fileUrl = `/api/upload/files/${basename(file.filename)}`
    // multer 的 originalname 是 latin1 解码（中文文件名乱码）→ 转回 utf8（ASCII 无损）
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8')

    // Save to database
    db.prepare(
      'INSERT INTO uploads (id, session_id, original_name, stored_name, mime_type, size, url) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      fileId,
      sessionId,
      originalName,
      file.filename,
      file.mimetype,
      file.size,
      fileUrl
    )

    return {
      id: fileId,
      name: originalName,
      type: file.mimetype,
      size: file.size,
      url: fileUrl,
    }
    }))

    ctx.body = { files: save() }
    ctx.status = 201
  } catch (error) {
    // Multer has already stored the entire batch. If database persistence
    // fails, remove those files so the failed upload leaves no orphaned data.
    for (const file of files) {
      try { unlinkSync(join(UPLOAD_DIR, basename(file.filename))) }
      catch (cleanupError) { console.error('[upload] failed to clean up upload:', cleanupError) }
    }
    console.error('[upload] failed to persist upload:', error)
    ctx.status = 500
    ctx.body = { error: '上传保存失败，请重试', code: 'UPLOAD_SAVE_FAILED' }
  }
})

// Serve uploaded files
uploadRouter.get('/files/:filename', (ctx: Context) => {
  const filePath = join(UPLOAD_DIR, ctx.params.filename)

  if (!existsSync(filePath)) {
    ctx.status = 404
    ctx.body = { error: '文件不存在', code: 'FILE_NOT_FOUND' }
    return
  }

  // Set content type based on extension
  const ext = extname(ctx.params.filename).toLowerCase()
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp', '.pdf': 'application/pdf',
    '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html',
    '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
    '.md': 'text/markdown', '.zip': 'application/zip', '.gz': 'application/gzip',
  }

  // Never serve active uploaded content (HTML/SVG/JS, etc.) as same-origin
  // executable content. Only known passive formats may be previewed inline.
  const inlineExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.pdf', '.txt', '.csv', '.md', '.json'])
  const inline = inlineExtensions.has(ext)
  ctx.set('Content-Type', inline ? (mimeMap[ext] || 'application/octet-stream') : 'application/octet-stream')
  ctx.set('X-Content-Type-Options', 'nosniff')
  ctx.set('Content-Security-Policy', "sandbox; default-src 'none'")
  ctx.set('Cache-Control', 'public, max-age=86400')
  ctx.set('Content-Disposition', inline ? 'inline' : 'attachment')
  ctx.body = createReadStream(filePath)
})

// Read text content of uploaded file (for Agent to process)
uploadRouter.get('/read/:id', (ctx: Context) => {
  const db = getDB()
  const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(ctx.params.id) as any

  if (!upload) {
    ctx.status = 404
    ctx.body = { error: 'File not found' }
    return
  }

  const filePath = join(UPLOAD_DIR, upload.stored_name)
  if (!existsSync(filePath)) {
    ctx.status = 404
    ctx.body = { error: 'File not on disk' }
    return
  }

  const mime = upload.mime_type || ''
  const isText = mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/yaml' ||
    mime === 'application/javascript'

  if (!isText) {
    ctx.body = {
      readable: false,
      type: mime,
      name: upload.original_name,
      message: `Cannot extract text from ${mime} files. The agent can reference this file at: ${upload.url}`,
    }
    return
  }

  try {
    const content = readFileSync(filePath, 'utf-8')
    ctx.body = {
      readable: true,
      type: mime,
      name: upload.original_name,
      content: content.slice(0, 50000),
    }
  } catch {
    ctx.body = {
      readable: false,
      type: mime,
      name: upload.original_name,
      message: 'Failed to read file content.',
    }
  }
})

// Delete uploaded file
uploadRouter.delete('/:id', (ctx: Context) => {
  const db = getDB()
  const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(ctx.params.id) as any

  if (!upload) {
    ctx.status = 404
    ctx.body = { error: '文件不存在', code: 'FILE_NOT_FOUND' }
    return
  }

  // Delete from disk
  const filePath = join(UPLOAD_DIR, upload.stored_name)
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath)
    } catch (error) {
      console.error('[upload] failed to delete upload:', error)
      ctx.status = 500
      ctx.body = { error: '文件删除失败，请重试', code: 'UPLOAD_DELETE_FAILED' }
      return
    }
  }

  // Delete from database
  db.prepare('DELETE FROM uploads WHERE id = ?').run(ctx.params.id)

  ctx.body = { success: true }
})
