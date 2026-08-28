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
 * 图片代理（2026-08-28 加：用户浏览器/网络直连 supercrzy.com/uploads 加载图可能被代理拉慢/失败）。
 * 前端用 /api/news/image?url= 走后端拿图，规避跨域/直连网络问题（后端能访问源，已验证可达）。
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
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(12000) })
    if (!resp.ok) { ctx.status = resp.status; ctx.body = Buffer.alloc(0); return }
    const type = resp.headers.get('content-type') || 'image/jpeg'
    const buf = await resp.arrayBuffer()
    ctx.set('Content-Type', type)
    ctx.set('Cache-Control', 'public, max-age=300')
    ctx.body = Buffer.from(buf)
  } catch (e: any) {
    ctx.status = 502
    ctx.body = { error: `图片代理失败: ${e?.message || e}` }
  }
})
