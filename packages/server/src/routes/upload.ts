import Router from 'koa-router'
import type { Context } from 'koa'
import { v4 as uuidv4 } from 'uuid'
import { existsSync, mkdirSync, unlinkSync, createReadStream } from 'fs'
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
function fileFilter(_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  const allowedTypes = [
    // Images
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp',
    // Documents
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // Text/Code
    'text/plain', 'text/csv', 'text/html', 'text/css', 'text/javascript', 'text/markdown',
    'application/json', 'application/xml', 'application/yaml',
    'application/zip', 'application/x-tar', 'application/gzip',
  ]

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true)
  } else {
    cb(new Error(`不支持的文件类型: ${file.mimetype}`))
  }
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
uploadRouter.post('/', upload.array('files', 5), async (ctx: Context) => {
  const files = ctx.files as Express.Multer.File[] | undefined

  if (!files || files.length === 0) {
    ctx.status = 400
    ctx.body = { error: '没有文件上传' }
    return
  }

  const db = getDB()
  const sessionId = ctx.request.body?.session_id || null

  const results = files.map((file) => {
    const fileId = uuidv4()
    const fileUrl = `/api/upload/files/${basename(file.filename)}`

    // Save to database
    db.prepare(
      'INSERT INTO uploads (id, session_id, original_name, stored_name, mime_type, size, url) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      fileId,
      sessionId,
      file.originalname,
      file.filename,
      file.mimetype,
      file.size,
      fileUrl
    )

    return {
      id: fileId,
      name: file.originalname,
      type: file.mimetype,
      size: file.size,
      url: fileUrl,
    }
  })

  ctx.body = { files: results }
  ctx.status = 201
})

// Serve uploaded files
uploadRouter.get('/files/:filename', (ctx: Context) => {
  const filePath = join(UPLOAD_DIR, ctx.params.filename)

  if (!existsSync(filePath)) {
    ctx.status = 404
    ctx.body = { error: '文件不存在' }
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

  ctx.set('Content-Type', mimeMap[ext] || 'application/octet-stream')
  ctx.set('Cache-Control', 'public, max-age=86400')
  // Allow inline preview for images and PDFs
  ctx.set('Content-Disposition', 'inline')
  ctx.body = createReadStream(filePath)
})

// Delete uploaded file
uploadRouter.delete('/:id', (ctx: Context) => {
  const db = getDB()
  const upload = db.prepare('SELECT * FROM uploads WHERE id = ?').get(ctx.params.id) as any

  if (!upload) {
    ctx.status = 404
    ctx.body = { error: '文件不存在' }
    return
  }

  // Delete from disk
  const filePath = join(UPLOAD_DIR, upload.stored_name)
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath)
    } catch {
      // Ignore delete errors
    }
  }

  // Delete from database
  db.prepare('DELETE FROM uploads WHERE id = ?').run(ctx.params.id)

  ctx.body = { success: true }
})
