/**
 * OCR 识别接口（本地 RapidOCR，免费开源：PaddleOCR 模型 + ONNX 轻量推理）
 * POST /api/ocr { path: 图片路径（工作区内） } → { texts: string[], elapsed: number }
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { safePath } from './workspace'

const execFileP = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
// 默认用系统 python3（可被 OCR_PYTHON_BIN 覆盖）；跨机不再依赖本机绝对路径
const PYTHON_BIN = process.env.OCR_PYTHON_BIN || 'python3'
const OCR_SCRIPT = join(__dirname, '../../scripts/ocr_service.py')

export const ocrRouter = new Router({ prefix: '/api/ocr' })

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
  try {
    const { stdout } = await execFileP(PYTHON_BIN, [OCR_SCRIPT, safe], { timeout: 30000 })
    ctx.body = JSON.parse(stdout)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})
