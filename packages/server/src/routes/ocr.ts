/**
 * OCR endpoints.
 * POST /api/ocr { path } → { texts, engine, elapsed, error? }   (engine chain, see services/ocr-engine.ts)
 * GET  /api/ocr/engine   → engines available on this platform (diagnostics)
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { join } from 'path'
import { runOcr, ocrEngineStatus } from '../services/ocr-engine'
import { safePath } from './workspace'

export const ocrRouter = new Router({ prefix: '/api/ocr' })

ocrRouter.get('/engine', (ctx: Context) => {
  ctx.body = ocrEngineStatus()
})

ocrRouter.post('/', async (ctx: Context) => {
  const { path } = (ctx.request.body || {}) as { path?: string }
  if (!path) {
    ctx.status = 400
    ctx.body = { error: '缺少 path 参数' }
    return
  }
  // 上传的图片（/uploads/xxx 或 /api/upload/files/xxx）→ 映射到上传目录；其他路径 → 工作区校验
  let safe = ''
  if (path.startsWith('/uploads/') || path.startsWith('/api/upload/files/')) {
    const filename = path.split('/').pop() || ''
    safe = join(process.cwd(), 'uploads', filename)
  } else {
    safe = safePath(path) || ''
  }
  if (!safe) {
    ctx.status = 400
    ctx.body = { error: '路径不在工作区内' }
    return
  }
  const result = await runOcr(safe)
  // No engine at all is a 503 — the client should show "OCR unavailable", not "no text found".
  if (result.engine === 'none') {
    ctx.status = 503
    ctx.body = { texts: [], engine: 'none' as const, elapsed: result.elapsed, error: result.error }
    return
  }
  ctx.body = result
})

