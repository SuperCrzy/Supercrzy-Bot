import Router from 'koa-router'
import type { Context } from 'koa'
import { createHash } from 'crypto'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { fetchSupercrzyNews, searchSupercrzyNews } from '../services/supercrzy-feed'

/**
 * News API — supercrzy.com AI 新闻看板后端（2026-08-28 加，阶段二）。
 * 供前端 NewsView.vue 读取：
 * - GET /api/news            → 全量新闻（按日期倒序）
 * - GET /api/news?category=Models → 按分类过滤
 * - GET /api/news?query=xxx  → 关键词搜索
 */
export const newsRouter = new Router({ prefix: '/api/news' })

// ─────────────────────────────────────────────────────────────
// 图片代理的缓存 + 重试 + 完整性校验（2026-10-18 加）
//
// 为什么必须做（实测依据，不是猜）：
//   从外网串行拉同一张 772 KB 的图 6 次，其中 2 次是「HTTP 200 但只收到
//   620 KB / 751 KB」，25s 后超时。而服务器本机 8 次全部 772307B 一致
//   ⇒ 抖动发生在公网链路/TLS 这一段，nginx 本身无问题，但**它确实会发生**。
//   当时后端三个防护一个都没有：零缓存、零重试、不校验 Content-Length
//   ⇒ 任何一次抖动都直接变成前端裂图；而且每次刷新都重新回源，所以"慢"。
//
// 三条防线：
//   ① 磁盘缓存：按 (url + 目标宽度) 哈希存文件，命中直接读盘（毫秒级）
//   ② 重试：分块读取时边读边比对 Content-Length，不足则重试，最多 2 次
//   ③ 完整性：拿到全长才落缓存；短读一律不写缓存，避免把半张图永久固化
// ─────────────────────────────────────────────────────────────
const IMG_CACHE_DIR = join(homedir(), '.supercrzy', 'cache', 'news-images')
const IMG_CACHE_TTL_MS = 7 * 24 * 3600 * 1000   // 7 天（上游 Cache-Control 是 30 天，取更保守值）
const IMG_FETCH_TIMEOUT_MS = 8000               // 单次尝试 8s（原来 12s 且无重试）
const IMG_MAX_ATTEMPTS = 3                      // 首次 + 2 次重试
const IMG_MAX_BYTES = 12 * 1024 * 1024          // 单图上限 12 MB，防异常大文件打爆磁盘

/** 1×1 透明 PNG（68 字节）：重试全部失败时的占位图，避免前端显示裂图 */
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

type CachedImage = { buf: Buffer; type: string; at: number }
const imgMemCache = new Map<string, CachedImage>()   // 进程内一级缓存（避免每次都读盘）
const IMG_MEM_MAX = 120                             // 进程内上限，约几十 MB

function imgCacheKey(url: string, width: number): string {
  return createHash('sha256').update(`${url}|${width}`).digest('hex')
}

/** 读缓存：先内存，再磁盘（过期/损坏则视为未命中） */
async function readImgCache(key: string): Promise<CachedImage | null> {
  const mem = imgMemCache.get(key)
  if (mem) {
    if (Date.now() - mem.at < IMG_CACHE_TTL_MS) return mem
    imgMemCache.delete(key)
  }
  try {
    const metaPath = join(IMG_CACHE_DIR, `${key}.json`)
    const binPath = join(IMG_CACHE_DIR, `${key}.bin`)
    const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8')) as { type: string; at: number; size: number }
    if (Date.now() - meta.at >= IMG_CACHE_TTL_MS) return null
    const buf = await fsp.readFile(binPath)
    // 磁盘文件被截断/损坏 → 当作未命中，重新拉
    if (buf.length !== meta.size) return null
    const hit = { buf, type: meta.type, at: meta.at }
    putImgMem(key, hit)
    return hit
  } catch {
    return null
  }
}

function putImgMem(key: string, val: CachedImage): void {
  if (imgMemCache.size >= IMG_MEM_MAX) {
    const oldest = imgMemCache.keys().next().value
    if (oldest) imgMemCache.delete(oldest)
  }
  imgMemCache.set(key, val)
}

/** 写缓存：落盘失败不影响请求（缓存是优化，不是正确性依赖） */
async function writeImgCache(key: string, val: CachedImage): Promise<void> {
  putImgMem(key, val)
  try {
    await fsp.mkdir(IMG_CACHE_DIR, { recursive: true })
    await fsp.writeFile(join(IMG_CACHE_DIR, `${key}.bin`), val.buf)
    await fsp.writeFile(join(IMG_CACHE_DIR, `${key}.json`), JSON.stringify({
      type: val.type, at: val.at, size: val.buf.length,
    }))
  } catch { /* 磁盘满/无权限 → 静默降级为仅内存缓存 */ }
}

/**
 * 带完整性校验的下载。
 * 🔴 关键：`resp.arrayBuffer()` 在连接提前关闭时会返回**不完整**的缓冲且不抛错，
 *    必须拿 Content-Length 比对；不足就重试。这是修「HTTP 200 但字节数不足」的核心。
 */
async function fetchImageSafely(url: string): Promise<{ buf: Buffer; type: string } | null> {
  let lastErr: any = null
  for (let attempt = 1; attempt <= IMG_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(IMG_FETCH_TIMEOUT_MS) })
      if (!resp.ok) {
        // 4xx 不重试（资源真的不存在），5xx 重试
        if (resp.status >= 400 && resp.status < 500) return null
        throw new Error(`HTTP ${resp.status}`)
      }
      const type = resp.headers.get('content-type') || 'image/jpeg'
      const declaredRaw = resp.headers.get('content-length')
      const declared = declaredRaw ? Number(declaredRaw) : NaN
      if (Number.isFinite(declared) && declared > IMG_MAX_BYTES) {
        throw new Error(`图片过大 ${declared}B`)
      }
      const buf = Buffer.from(await resp.arrayBuffer())
      // 完整性校验：声明了长度就必须对得上
      if (Number.isFinite(declared) && buf.length !== declared) {
        throw new Error(`不完整 ${buf.length}/${declared}B`)
      }
      if (buf.length === 0) throw new Error('空响应')
      return { buf, type }
    } catch (e: any) {
      lastErr = e
      // 最后一次失败直接退出，否则退避后重试
      if (attempt < IMG_MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 300 * attempt))
      }
    }
  }
  console.warn(`[NewsImage] 下载失败（已重试 ${IMG_MAX_ATTEMPTS} 次）: ${url} — ${lastErr?.message || lastErr}`)
  return null
}

newsRouter.get('/', async (ctx: Context) => {
  const category = String(ctx.query.category || '').trim()
  const query = String(ctx.query.query || '').trim()
  const limit = Math.min(Number(ctx.query.limit) || 20, 30)

  try {
    const items = await searchSupercrzyNews({ query, category, limit })
    ctx.body = { items }
  } catch (e: any) {
    ctx.status = 500
    ctx.body = { error: `新闻拉取失败: ${e?.message || e}` }
  }
})

/** 新增：读取一个分类维度/刷新缓存时校验源可达 */
newsRouter.get('/categories', async (ctx: Context) => {
  try {
    const all = await fetchSupercrzyNews()
    const cats = [...new Set(all.map((n) => n.category))]
    ctx.body = { categories: cats }
  } catch (e: any) {
    ctx.status = 500
    ctx.body = { error: `分类获取失败: ${e?.message || e}` }
  }
})

/**
 * 图片代理（2026-08-28 加：规避跨域/直连失败；2026-08-29 加压缩）。
 * 前端 /api/news/image?url= 走后端拿图。
 * 参数：
 *   ?w=400         按宽度缩放并转 WebP（列表缩略图场景，压缩 70-85%）
 *   ?full=1        跳过压缩，返回高清原图（详情页大图用）
 *   无参数         默认压到 800px 宽 + WebP（防超巨大图拖慢）
 * 只允许 supercrzy.com 域名（防 SSRF）。
 */
newsRouter.get('/image', async (ctx: Context) => {
  const url = String(ctx.query.url || '')
  // 只允许 supercrzy.com 域名，防 SSRF
  let host: string
  try { host = new URL(url).host } catch { ctx.status = 400; ctx.body = { error: 'url 无效' }; return }
  if (host !== 'supercrzy.com' && !host.endsWith('.supercrzy.com')) {
    ctx.status = 400
    ctx.body = { error: '仅允许 supercrzy.com 图片' }
    return
  }
  const isFull = ctx.query.full === '1' || ctx.query.full === 'true'
  // 目标宽度：显式 w 参数优先，否则默认 800（本地上传图常见 1280+ 宽，压到 800 足够列表/卡片）
  const wRaw = Number(ctx.query.w || 0)
  const targetWidth = Number.isFinite(wRaw) && wRaw >= 32 ? Math.round(wRaw) : (isFull ? 0 : 800)

  // ① 缓存命中直接返回（毫秒级，这是解决"加载慢"的主要手段）
  const cacheKey = imgCacheKey(url, targetWidth)
  const cached = await readImgCache(cacheKey)
  if (cached) {
    ctx.set('Content-Type', cached.type)
    // 浏览器侧缓存 1 天 + 标记命中来源，便于排查
    ctx.set('Cache-Control', 'public, max-age=86400')
    ctx.set('X-Img-Cache', 'hit')
    ctx.body = cached.buf
    return
  }

  try {
    // ② 安全下载：8s 超时 × 最多 3 次，每次都校验 Content-Length
    const downloaded = await fetchImageSafely(url)
    if (!downloaded) {
      // ③ 全部重试失败 → 返回轻量占位图（1x1 透明 PNG，48B），前端不再是裂图
      ctx.status = 200
      ctx.set('Content-Type', 'image/png')
      ctx.set('Cache-Control', 'no-store')
      ctx.set('X-Img-Cache', 'fallback')
      ctx.body = PLACEHOLDER_PNG
      return
    }
    const { buf, type } = downloaded

    let outBuf: Buffer = buf
    let outType: string = type

    // 压缩路径：sharp 按宽度缩放 + 转 WebP（对 width>targetWidth 的图有收益；小图不改）
    if (!isFull && targetWidth > 0) {
      try {
        const sharp = (await import('sharp')).default
        const img = sharp(buf)
        const meta = await img.metadata()
        const srcW = meta.width || 0
        // 原图已经比目标窄 → 不压缩（避免无谓重编码）
        if (srcW > 0 && srcW > targetWidth) {
          outBuf = await img
            .resize({ width: targetWidth, withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer()
          outType = 'image/webp'
        }
      } catch (sharperr: any) {
        // sharp 处理失败（非图片/特殊格式）→ 回退原图，不影响返回
        console.warn(`[NewsImage] sharp 压缩失败，回退原图: ${sharperr?.message || sharperr}`)
      }
    }

    // 落缓存（此时已确认内容完整）
    await writeImgCache(cacheKey, { buf: outBuf, type: outType, at: Date.now() })

    ctx.set('Content-Type', outType)
    ctx.set('Cache-Control', 'public, max-age=86400')
    ctx.set('X-Img-Cache', 'miss')
    ctx.body = outBuf
  } catch (e: any) {
    // 兜底：任何未预期异常也给占位图，绝不返回 502 让前端裂图
    console.warn(`[NewsImage] 代理异常: ${e?.message || e}`)
    ctx.status = 200
    ctx.set('Content-Type', 'image/png')
    ctx.set('Cache-Control', 'no-store')
    ctx.set('X-Img-Cache', 'error')
    ctx.body = PLACEHOLDER_PNG
  }
})
