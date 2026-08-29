import Router from 'koa-router'
import type { Context } from 'koa'
import { fetchSupercrzyNews, searchSupercrzyNews } from '../services/supercrzy-feed'

/**
 * News API — supercrzy.com AI 新闻看板后端（2026-08-28 加，阶段二）。
 * 供前端 NewsView.vue 读取：
 * - GET /api/news            → 全量新闻（按日期倒序）
 * - GET /api/news?category=Models → 按分类过滤
 * - GET /api/news?query=xxx  → 关键词搜索
 */
export const newsRouter = new Router({ prefix: '/api/news' })

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
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(12000) })
    if (!resp.ok) { ctx.status = resp.status; ctx.body = Buffer.alloc(0); return }
    const type = resp.headers.get('content-type') || 'image/jpeg'
    const buf = Buffer.from(await resp.arrayBuffer())

    // 不改尺寸时原样返回（full=1 或目标宽度 >= 原图宽，不放大）
    if (isFull || targetWidth === 0) {
      ctx.set('Content-Type', type)
      ctx.set('Cache-Control', 'public, max-age=300')
      ctx.body = buf
      return
    }

    // 压缩路径：sharp 按宽度缩放 + 转 WebP（对 width>targetWidth 的图有收益；小图不改）
    try {
      const sharp = (await import('sharp')).default
      const img = sharp(buf)
      const meta = await img.metadata()
      const srcW = meta.width || 0
      // 原图已经比目标窄 → 直接原样返回（避免无谓重编码，且长度也小）
      if (srcW > 0 && srcW <= targetWidth) {
        ctx.set('Content-Type', type)
        ctx.set('Cache-Control', 'public, max-age=300')
        ctx.body = buf
        return
      }
      const compressed = await img
        .resize({ width: targetWidth, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer()
      ctx.set('Content-Type', 'image/webp')
      ctx.set('Cache-Control', 'public, max-age=300')
      ctx.body = compressed
    } catch (sharperr: any) {
      // sharp 处理失败（非图片/特殊格式）→ 回退原图
      console.warn(`[NewsImage] sharp 压缩失败，回退原图: ${sharperr?.message || sharperr}`)
      ctx.set('Content-Type', type)
      ctx.set('Cache-Control', 'public, max-age=300')
      ctx.body = buf
    }
  } catch (e: any) {
    ctx.status = 502
    ctx.body = { error: `图片代理失败: ${e?.message || e}` }
  }
})
