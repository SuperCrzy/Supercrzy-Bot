import type { Context } from 'koa'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { mediaMimeOf, isNonPreviewableBinary, docxMimeOf } from '../services/file-kind'
import { resolvePreviewPath } from '../services/preview-path'
import { renderPreviewPage } from '../services/tunnel'

const PREVIEW_MAX_BYTES = 5 * 1024 * 1024

/** The caller handles authentication and invokes this only for /api/preview/. */
export async function servePreview(ctx: Context, workspaceRoot: string): Promise<void> {
  let filePath: string
  try { filePath = decodeURIComponent(ctx.path.slice('/api/preview/'.length)) }
  catch { ctx.status = 400; ctx.body = 'Invalid preview path'; return }
  const target = await resolvePreviewPath(workspaceRoot, filePath)
  if (!target.ok) {
    ctx.status = target.reason === 'forbidden' ? 403 : 404
    ctx.body = target.reason === 'forbidden' ? 'Forbidden: invalid preview path' : 'File not found'
    return
  }
  const absPath = target.path
  let previewSize: number
  try { previewSize = (await stat(absPath)).size } catch { ctx.status = 404; ctx.body = 'File not found'; return }
  if (previewSize > PREVIEW_MAX_BYTES) {
    ctx.status = 413
    ctx.body = `File too large to preview: ${(previewSize / 1024 / 1024).toFixed(1)} MB (limit ${PREVIEW_MAX_BYTES / 1024 / 1024} MB)`
    return
  }
  const previewMime = mediaMimeOf(absPath)
  if (previewMime) {
    ctx.type = previewMime
    ctx.set('Content-Length', String(previewSize))
    ctx.set('X-Content-Type-Options', 'nosniff')
    if (previewMime.startsWith('image/')) ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    ctx.body = createReadStream(absPath)
    return
  }
  if (docxMimeOf(absPath)) {
    ctx.status = 415
    ctx.body = `Word document is not previewable as a page: ${filePath}`
    return
  }
  if (isNonPreviewableBinary(absPath)) {
    ctx.status = 415
    ctx.body = `Binary file (not text-previewable): ${filePath}`
    return
  }
  const content = await readFile(absPath, 'utf-8')
  ctx.type = 'html'
  ctx.body = renderPreviewPage(filePath, content)
}
