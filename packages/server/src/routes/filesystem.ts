import Router from 'koa-router'
import { readdirSync, existsSync, createReadStream } from 'fs'
import { readFile, stat } from 'fs/promises'
import { join, resolve, dirname } from 'path'
import { homedir } from 'os'
import { assertSafeFilePath } from '../services/sandbox'
import { mediaMimeOf, isNonPreviewableBinary, docxMimeOf, isMarkdownPath, isSvgPath } from '../services/file-kind'

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
  // ⚠️ 二进制不能当 utf-8 读（2026-09-29：这正是"AI 截屏在右栏预览成乱码"的根因）。
  // 真机实测：旧代码对 152 KB 的 PNG 返回 200 + 353525 字节 JSON，content 全是 \ufffd 替换字符。
  const mediaMime = mediaMimeOf(safePath)
  if (mediaMime) {
    ctx.body = {
      path: safePath,
      kind: 'media',
      mime: mediaMime,
      size: fileStat.size,
      // 前端 `<img src>` 不能带自定义请求头 ⇒ 用同源 GET 直出原始字节（同一套沙箱校验）
      url: `/api/filesystem/raw?path=${encodeURIComponent(safePath)}`,
    }
    return
  }
  // Word（OOXML）：不能当文本读，但也不该只给一句"不支持" —— 前端有 docx-preview，
  // 所以这里跟 media 一样只回地址，由前端拉原始字节自行渲染（2026-10-20）。
  // ⚠️ 必须排在 `isNonPreviewableBinary` **之前**：`.docx` 若被并列进 BINARY_ONLY_EXT 就永远读不到这里。
  const docxMime = docxMimeOf(safePath)
  if (docxMime) {
    ctx.body = {
      path: safePath,
      kind: 'docx',
      mime: docxMime,
      size: fileStat.size,
      url: `/api/filesystem/raw?path=${encodeURIComponent(safePath)}`,
    }
    return
  }
  if (isNonPreviewableBinary(safePath)) {
    ctx.body = {
      path: safePath,
      kind: 'binary',
      mime: 'application/octet-stream',
      size: fileStat.size,
      message: `二进制文件（${(fileStat.size / 1024).toFixed(1)} KB）不支持文本预览`,
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
    // `start`/`end` 是**调用方显式传的**定位范围（0 = 没传），不是上面归一化后的 s/e
    const hasRange = start > 0 || end > 0
    ctx.body = {
      path: safePath,
      // markdown 与纯文本的**内容**相同，只是前端渲染方式不同（渲染 vs 等宽平铺）；
      // 判定放在这里而不是前端各自判扩展名，避免出现第二份清单（2026-10-20）。
      // ⚠️ 但**带行号范围时一律按纯文本**：那次调用是"定位到第 N 行"（正文路径链接 / read_file），
      // 只拿到中间几行 —— 半截 markdown 渲染出来只会是错乱的层级和残缺表格，
      // 而且渲染后行号也对不上。定位场景要的就是"看到原文那几行"。
      kind: hasRange
        ? 'text'
        : isSvgPath(safePath)
          ? 'svg'
          : isMarkdownPath(safePath)
            ? 'markdown'
            : 'text',
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

/**
 * 原始字节直出（2026-09-29 新增）：图片 / PDF 等媒体交给浏览器自己渲染。
 *
 * 为什么**必须**新增这条：历史上没有任何"工作区文件直出"的链路 —— koa-static 只挂了
 * `client/dist`，实测 `GET /uploads/screenshots/screen-*.png` 拿到的是 SPA 的 index.html
 * （200 + text/html + 2330 字节），所以前端根本拿不到可用的 `<img src>`。
 *
 * 安全边界（三条都要，缺一条就变成漏洞）：
 *   ① 与 `/read` **同一套** `assertSafeFilePath` 沙箱校验（含凭据文件/敏感目录拦截）；
 *   ② 只放行 `file-kind` 里白名单的类型 —— 不让本路由变成"任意文件下载"通道；
 *   ③ 大小上限与文本预览一致 + `nosniff` + 图片加 CSP（媒体不需要脚本能力）。
 *
 * 2026-10-20：白名单加 `.docx`（`docxMimeOf`）。它只是 zip 数据、不具脚本能力，
 * 且响应带 `nosniff` + OOXML 的 Content-Type ⇒ 浏览器不会当 HTML 执行。
 */
fsRouter.get('/raw', async (ctx) => {
  const raw = String(ctx.query.path || '').trim()
  if (!raw) { ctx.status = 400; ctx.body = { error: '缺少 path 参数' }; return }
  const pathErr = assertSafeFilePath(raw)
  if (pathErr) { ctx.status = 403; ctx.body = { error: `路径不在白名单内：${pathErr}` }; return }
  const safePath = resolve(raw)
  const mime = mediaMimeOf(safePath) || docxMimeOf(safePath)
  if (!mime) { ctx.status = 415; ctx.body = { error: '该类型不支持内嵌预览' }; return }
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(safePath)
  } catch {
    ctx.status = 404
    ctx.body = { error: '文件不存在' }
    return
  }
  if (!st.isFile()) { ctx.status = 404; ctx.body = { error: '文件不存在' }; return }
  if (st.size > MAX_PREVIEW_BYTES) {
    ctx.status = 413
    ctx.body = { error: `文件过大（${(st.size / 1024 / 1024).toFixed(1)} MB），预览上限 ${MAX_PREVIEW_BYTES / 1024 / 1024} MB` }
    return
  }
  ctx.set('Content-Type', mime)
  ctx.set('Content-Length', String(st.size))
  ctx.set('Cache-Control', 'no-store')
  ctx.set('X-Content-Type-Options', 'nosniff')
  // 只对图片收紧 CSP：PDF 走浏览器内置阅读器，加 CSP 有概率把它打坏（收益也低）
  if (mime.startsWith('image/')) ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  // 流式直出（与 upload.ts 的 /files/:id 同款）；不用 readFile 是为了不把整个文件读进内存
  ctx.body = createReadStream(safePath)
})
