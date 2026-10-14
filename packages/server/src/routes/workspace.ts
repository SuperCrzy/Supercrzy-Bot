/**
 * Workspace 文件服务 — HTTP 版
 * 供 DetailPanel 文件 Tab / 工作台使用
 * 安全：所有路径必须位于 workspace 根目录内（白名单），防目录穿越
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { readdir, readFile, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { config } from '../config'
import { getDB } from '../services/database'
import { mediaMimeOf, isNonPreviewableBinary } from '../services/file-kind'

export const workspaceRouter = new Router({ prefix: '/api/workspace' })

const WORKSPACE_ROOT = resolve(config.workspaceDir || process.cwd())

/** 动态工作区根：优先最近会话绑定目录（AI 真正干活的地方），回退 WORKSPACE_ROOT */
function resolveWorkspaceRoot(): string {
  try {
    const db = getDB()
    const row = db.prepare(`
      SELECT workspace_dir FROM sessions
      WHERE workspace_dir != '' AND workspace_dir IS NOT NULL
        AND COALESCE(is_playground, 0) = 0
      ORDER BY created_at DESC LIMIT 1
    `).get() as { workspace_dir?: string } | undefined
    return row?.workspace_dir || WORKSPACE_ROOT
  } catch {
    return WORKSPACE_ROOT
  }
}

/** 校验并规范化路径：必须在工作区根内，否则返回 null（导出供单测） */
export function safePath(input: string): string | null {
  if (!input || input.includes('\0')) return null
  const root = resolveWorkspaceRoot()
  const abs = resolve(root, input)
  if (abs !== root && !abs.startsWith(root + '/')) return null
  return abs
}

// ---- 工作区索引（参考 主流实现 workspaces 表）----

// 记录/更新工作区打开时间（会话创建/切换时调用）
export function upsertWorkspace(workspacePath: string) {
  if (!workspacePath) return
  const db = getDB()
  db.prepare(
    'INSERT INTO workspaces (path, last_opened_at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at'
  ).run(resolve(workspacePath), Date.now())
}

// 工作区列表：最近打开且仍有活跃会话（非 playground）的目录
workspaceRouter.get('/list', (ctx: Context) => {
  const db = getDB()
  const rows = db.prepare(`
    SELECT DISTINCT s.workspace_dir as path, w.last_opened_at
    FROM sessions s
    LEFT JOIN workspaces w ON w.path = s.workspace_dir
    WHERE s.workspace_dir != '' AND s.workspace_dir IS NOT NULL
      AND COALESCE(s.is_playground, 0) = 0
    ORDER BY COALESCE(w.last_opened_at, 0) DESC
  `).all() as Array<{ path: string; last_opened_at: number }>
  ctx.body = { workspaces: rows.filter((r) => r.path) }
})

// 记录打开工作区（前端切换时调用）
workspaceRouter.post('/open', (ctx: Context) => {
  const body = ctx.request.body as { path?: string }
  if (!body.path) {
    ctx.status = 400
    ctx.body = { error: 'path is required' }
    return
  }
  upsertWorkspace(body.path)
  ctx.body = { success: true }
})

// 文件列表
workspaceRouter.get('/files', async (ctx: Context) => {
  const dirInput = (ctx.query.dir as string) || ''
  const dirPath = safePath(dirInput || '.')
  if (!dirPath) {
    ctx.status = 400
    ctx.body = { error: 'Invalid path: must be inside workspace' }
    return
  }

  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const files = await Promise.all(
      entries
        .filter(e => !e.name.startsWith('.') || e.name === '.gitignore')
        .map(async (e) => {
          const fullPath = join(dirPath, e.name)
          let size = 0
          let mtime = ''
          try {
            const s = await stat(fullPath)
            size = s.size
            mtime = s.mtime.toISOString()
          } catch {}
          return {
            name: e.name,
            path: fullPath,
            type: e.isDirectory() ? 'directory' : 'file',
            size,
            mtime,
          }
        })
    )
    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    ctx.body = { files, path: dirPath, root: WORKSPACE_ROOT }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// 下载/预览二进制文件（图片等）：GET /api/workspace/file?path=xxx
workspaceRouter.get('/file', async (ctx: Context) => {
  const fileInput = (ctx.query.path as string) || ''
  const filePath = safePath(fileInput)
  if (!filePath) {
    ctx.status = 400
    ctx.body = { error: 'Invalid path: must be inside workspace' }
    return
  }
  try {
    const s = await stat(filePath)
    if (s.isDirectory()) {
      ctx.status = 400
      ctx.body = { error: 'Is a directory' }
      return
    }
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon',
      pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
      mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }
    ctx.type = mimeMap[ext] || 'application/octet-stream'
    ctx.body = await readFile(filePath)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// 读取文件内容（限制 100KB）
workspaceRouter.get('/files/content', async (ctx: Context) => {
  const fileInput = (ctx.query.path as string) || ''
  const filePath = safePath(fileInput)
  if (!filePath) {
    ctx.status = 400
    ctx.body = { error: 'Invalid path: must be inside workspace' }
    return
  }

  try {
    // 二进制不能当 utf-8 读（2026-09-29，与 /api/filesystem/read 同一处根因）。
    // 这条链路的唯一客户端调用方（DetailPanel 的非 html 分支）已改走 /api/filesystem/read，
    // 但 API 面对外，仍要堵住"把几 MB 乱码 JSON 吐回去"。
    if (mediaMimeOf(filePath)) {
      ctx.body = {
        path: filePath,
        kind: 'media',
        mime: mediaMimeOf(filePath),
        url: `/api/filesystem/raw?path=${encodeURIComponent(filePath)}`,
      }
      return
    }
    if (isNonPreviewableBinary(filePath)) {
      ctx.body = { path: filePath, kind: 'binary', message: '二进制文件不支持文本预览' }
      return
    }
    const content = await readFile(filePath, 'utf-8')
    ctx.body = { content: content.slice(0, 100000), path: filePath, kind: 'text' }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// 供调试：显示当前 workspace 根
export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT
}

export default workspaceRouter
