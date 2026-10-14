/**
 * supercrzy.com 内容源服务（2026-08-28 加：新闻生态接入的核心数据层）。
 *
 * 直接拉取 supercrzy.com/feed.xml（RSS 2.0，已验证可用：标准 title/link/guid/description/pubDate，
 * 30 条/次，实时更新）。供：
 * - tools/news-search.ts（Agent 对话内检索 AI 新闻）
 * - 未来 NewsView.vue 看板（侧边栏入口）
 *
 * 无需任何 API key —— 零成本、实时、与"新闻生态"理念完全契合（BOT 消化自家官网内容 = 差异化闭环）。
 */
import { getDB } from './database'

export interface SupercrzyNewsItem {
  title: string
  url: string
  /** 摘要（RSS description 去 HTML、去掉首图） */
  summary: string
  /** ISO 日期（RSS pubDate → 归一化） */
  date: string
  /** 分类推断（从标题/URL 关键词，见 NEWS_CATEGORIES） */
  category: string
  /** 封面图 URL（RSS description 首部的 <img>，2026-08-28 加；可能为空） */
  image?: string
}

/** feed 源 URL（可用 settings.supercrzyFeedUrl 覆盖） */
const DEFAULT_FEED_URL = 'https://supercrzy.com/feed.xml'

/** 分类关键词匹配（title + url 命中判断；对齐 supercrzy.com 官方 8 分类，2026-08-28） */
const NEWS_CATEGORIES: Array<{ name: string; keywords: string[] }> = [
  { name: 'Models', keywords: ['model', 'llm', 'gpt', 'claude', 'glm', 'kimi', 'deepseek', 'qwen', 'grok', 'hy4', 'gemini', 'weights', 'benchmark', 'inference', 'param'] },
  { name: 'Business', keywords: ['nvidia', 'funding', 'deal', 'ipo', 'revenue', 'acquisition', 'billion', 'market', 'business', 'startup', 'enterprise'] },
  { name: 'Agents', keywords: ['agent', 'harness', 'openclaw', 'codex', 'coding agent', 'workflow', 'plugin', 'autonomous agent', 'grok bot', 'ai agent'] },
  { name: 'Hardware', keywords: ['chip', 'gpu', 'robot', 'humanoid', 'device', 'asics', 'tpu', 'hardware', 'processor', 'ai pc', 'glasses', 'keyboard'] },
  { name: 'Applications', keywords: ['app', 'application', 'product', 'tool', 'software', 'workspace', 'search', 'browser', 'studio', 'photoshop', 'office', 'clip'] },
  { name: 'Autonomy', keywords: ['autonomy', 'self-driving', 'driving', 'agentic', 'autonomous', 'robotics control', 'household robot'] },
  { name: 'Open Source', keywords: ['open source', 'open-source', 'open weights', 'weights drop', 'hugging face', 'license', 'mit'] },
]

/** 从标题+URL 推断分类（未命中 → 综合 News） */
function classifyNews(title: string, url: string): string {
  for (const c of NEWS_CATEGORIES) {
    const hit = c.keywords.some((k) => title.toLowerCase().includes(k) || url.toLowerCase().includes(k))
    if (hit) return c.name
  }
  return 'News'
}

/** HTML 实体解码（&apos;/&quot;/&amp;/&lt;/&gt;/&#N; —— RSS 标题/摘要常见，2026-08-28 加） */
function decodeEntities(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
}

/** RSS description 去 HTML 标签 + 去首图（<img>） + 实体解码 → 纯文本摘要 */
function cleanSummary(desc: string): string {
  return desc
    .replace(/<img[^>]*>/gi, '') // 去首图
    .replace(/<[^>]*>/g, '')     // 去其余 HTML 标签
    .replace(/\s+/g, ' ')
    .trim()
}
/** 摘要实体解码（cleanSummary 去标签后再解码） */
function cleanSummaryDecoded(desc: string): string {
  return decodeEntities(cleanSummary(desc))
}

/** 提取 RSS description 开头的封面图 URL（<img src="...">），无则空 */
export function extractFirstImage(desc: string): string {
  const m = desc.match(/<img[^>]*src=["']([^"']+)["']/i)
  return m ? m[1] : ''
}

/** 解析 RSS XML 成新闻条目（导出供单测） */
export function parseFeedXml(xml: string): SupercrzyNewsItem[] {
  const items: SupercrzyNewsItem[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/
  const linkRegex = /<link>(.*?)<\/link>/
  const descRegex = /<description>([\s\S]*?)<\/description>/
  const dateRegex = /<pubDate>(.*?)<\/pubDate>/
  let m: RegExpExecArray | null
  while ((m = itemRegex.exec(xml)) !== null && items.length < 30) {
    const item = m[1]
    const titleM = item.match(titleRegex)
    const linkM = item.match(linkRegex)
    const descM = item.match(descRegex)
    const dateM = item.match(dateRegex)
    const title = decodeEntities(titleM ? (titleM[1] || titleM[2] || '').trim() : '')
    const url = linkM ? linkM[1].trim() : ''
    if (!title || !url) continue
    const date = dateM ? new Date(dateM[1].trim()).toISOString() : ''
    const rawDesc = descM ? descM[1] : ''
    items.push({
      title,
      url,
      summary: cleanSummaryDecoded(rawDesc).slice(0, 300),
      date,
      image: extractFirstImage(rawDesc),
      category: classifyNews(title, url),
    })
  }
  return items
}

/** 读取 feed 源 URL（settings.supercrzyFeedUrl 可覆盖，便于本地调试/换源） */
function feedUrl(): string {
  try {
    const row = getDB().prepare("SELECT value FROM settings WHERE key = 'supercrzyFeedUrl'").get() as any
    return row?.value?.trim() || DEFAULT_FEED_URL
  } catch {
    return DEFAULT_FEED_URL
  }
}

const CACHE_TTL = 5 * 60 * 1000 // 5 分钟缓存，避免每次对话都打源站
let cache: { at: number; items: SupercrzyNewsItem[] } | null = null

/**
 * 拉取 supercrzy.com 新闻（带 5 分钟缓存）。
 * 失败返回空数组（调用方自行降级，不抛异常阻塞主流程）。
 */
export async function fetchSupercrzyNews(): Promise<SupercrzyNewsItem[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache.items
  try {
    const resp = await fetch(feedUrl(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUPERCRZY-BOT/1.0)', 'Accept': 'application/rss+xml, application/xml' },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return cache?.items || []
    const xml = await resp.text()
    cache = { at: Date.now(), items: parseFeedXml(xml) }
    return cache.items
  } catch {
    return cache?.items || []
  }
}

/**
 * 检索新闻（news_search 工具 + NewsView 复用）：
 * - query：按标题/摘要关键词过滤（空 = 全量）
 * - category：按分类过滤（Models/Business/Hardware/Agents/Open Source/Research）
 * - limit：返回条数
 */
/**
 * 纯函数：按 query / category 过滤 + 按日期倒序 + limit 切片。
 *
 * 2026-09-20 从 searchSupercrzyNews 里抽出来：原实现把「过滤排序」和「网络拉取」焊在一起，
 * 导致这段逻辑只能靠打真源站来测（测试里写成 `expect(Array.isArray(r)).toBe(true)` 这种恒真断言，
 * 既给不出任何保障，又让单测依赖网络）。抽出来后可离线断言。
 */
export function filterNews(
  items: SupercrzyNewsItem[],
  opts: { query?: string; category?: string; limit?: number }
): SupercrzyNewsItem[] {
  let out = items.slice() // 不改调用方的数组
  const q = (opts.query || '').trim().toLowerCase()
  if (q) out = out.filter((n) => n.title.toLowerCase().includes(q) || n.summary.toLowerCase().includes(q))
  if (opts.category && opts.category !== 'all' && opts.category !== 'News') {
    const target = opts.category.toLowerCase()
    out = out.filter((n) => n.category.toLowerCase() === target || n.title.toLowerCase().includes(target))
  }
  // 按日期倒序（最新在前）
  out.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  return out.slice(0, opts.limit || 10)
}

export async function searchSupercrzyNews(opts: {
  query?: string
  category?: string
  limit?: number
}): Promise<SupercrzyNewsItem[]> {
  const items = await fetchSupercrzyNews()
  return filterNews(items, opts)
}
