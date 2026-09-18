import Router from 'koa-router'
import { readdirSync, existsSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { join, resolve, dirname } from 'path'
import { homedir } from 'os'
import { assertSafeFilePath } from '../services/sandbox'

/**
 * 文件内容预览的单文件上限。
 *
 * 2026-09-18：预览原本是 `readFileSync` 整文件读入再 split，阻塞时长与文件大小线性成正比——
 * 用户点开一个几百 MB 的日志，事件循环会被占住到读完为止，同后端上所有并发 SSE 流一起停推。
 * 改为异步读 + 明确上限：超限直接给可行动的提示，而不是让整个后端陪着卡。
 */
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

/**
 * 目录浏览/搜索 API：供前端"选择工作文件夹"弹窗使用。
 * 只返回目录名与路径（不读取文件内容），用户主动操作为了给 AI 指定工作区。
 */
export const fsRouter = new Router({ prefix: '/api/filesystem' })

/** 列出指定路径下的子目录 */
fsRouter.get('/dirs', async (ctx) => {
  const raw = String(ctx.query.path || homedir())
  const p = resolve(raw)
  if (!existsSync(p)) {
    ctx.body = { error: '路径不存在' }
    return
  }
  let st: Awaited<ReturnType<typeof stat>>
  try { st = await stat(p) } catch {
    ctx.body = { error: '无法访问' }
    return
  }
  if (!st.isDirectory()) {
    ctx.body = { error: '不是目录' }
    return
  }
  try {
    const dirs = readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => ({ name: d.name, path: join(p, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    ctx.body = { path: p, parent: p === resolve(homedir()) || p === resolve('/') ? null : dirname(p), dirs }
  } catch (err: any) {
    ctx.body = { error: err.message }
  }
})

/** 在常见位置搜索匹配目录名（HOME / 项目根 / /tmp，深度 ≤3） */
fsRouter.get('/search', (ctx) => {
  const q = String(ctx.query.q || '').trim().toLowerCase()
  if (q.length < 2) {
    ctx.body = { results: [] }
    return
  }
  const home = homedir()
  const roots = [home, process.cwd(), '/tmp']
  const results: Array<{ name: string; path: string }> = []
  const skip = new Set(['node_modules', '.git', 'Library', '.Trash', 'binaries', 'envs', 'versions'])
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || results.length >= 20) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || skip.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.name.toLowerCase().includes(q)) results.push({ name: e.name, path: full })
      walk(full, depth + 1)
    }
  }
  for (const r of roots) walk(r, 0)
  ctx.body = { results: results.slice(0, 20) }
})

/**
 * 读取文件内容（P0-1 正文路径检测 / P0-3 read_file 定位共用）。
 * 走 assertSafeFilePath 同一套沙箱白名单——shell 沙箱不堵文件工具等于白做，文件 API 同理。
 * 支持行号范围：?path=...&start=12&end=30（返回对应行区间 + 总行数，前端定位滚动）。
 */
fsRouter.get('/read', async (ctx) => {
  const raw = String(ctx.query.path || '').trim()
  const start = parseInt(String(ctx.query.start || ''), 10) || 0
  const end = parseInt(String(ctx.query.end || ''), 10) || 0
  if (!raw) {
    ctx.body = { error: '缺少 path 参数' }
    return
  }
  let safePath: string
  const pathErr = assertSafeFilePath(raw)
  if (pathErr) {
    ctx.body = { error: `路径不在白名单内：${pathErr}` }
    return
  }
  safePath = resolve(raw)
  let fileStat: Awaited<ReturnType<typeof stat>> | null = null
  try {
    fileStat = await stat(safePath)
  } catch {
    ctx.body = { error: '文件不存在' }
    return
  }
  if (!fileStat.isFile()) {
    ctx.body = { error: '文件不存在' }
    return
  }
  if (fileStat.size > MAX_PREVIEW_BYTES) {
    ctx.body = {
      error: `文件过大（${(fileStat.size / 1024 / 1024).toFixed(1)} MB），预览上限 ${MAX_PREVIEW_BYTES / 1024 / 1024} MB`,
      size: fileStat.size,
      tooLarge: true,
    }
    return
  }
  try {
    // 异步读：大文件不再同步占住事件循环（本路由只做预览，异步读完全够用）
    const allLines = (await readFile(safePath, 'utf-8')).split('\n')
    const totalLines = allLines.length
    const s = start > 0 ? Math.min(start, totalLines) : 1
    const e = end >= s ? Math.min(end, totalLines) : totalLines
    const lines = allLines.slice(s - 1, e)
    ctx.body = {
      path: safePath,
      totalLines,
      startLine: s,
      endLine: e,
      content: lines.join('\n'),
      // 完整行（带行号渲染用，定位视图用 content 即可）
      truncated: e < totalLines,
    }
  } catch (err: any) {
    ctx.body = { error: err.message }
  }
})
