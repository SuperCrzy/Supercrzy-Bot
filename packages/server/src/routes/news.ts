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
