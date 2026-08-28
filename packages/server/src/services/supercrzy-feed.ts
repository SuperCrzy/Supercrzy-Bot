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
  /** 摘要（RSS description 去 HTML/去掉首图） */
  summary: string
  /** ISO 日期（RSS pubDate → 归一化） */
  date: string
  /** 分类推断（从标题/URL 关键词，见 NEWS_CATEGORIES） */
  category: string
}

/** feed 源 URL（可用 settings.supercrzyFeedUrl 覆盖） */
const DEFAULT_FEED_URL = 'https://supercrzy.com/feed.xml'

/** 分类关键词匹配（title + url 命中判断） */
const NEWS_CATEGORIES: Array<{ name: string; keywords: string[] }> = [
  { name: 'Models', keywords: ['model', 'llm', 'gpt', 'claude', 'glm', 'kimi', 'deepseek', 'qwen', 'grok', 'hy4', 'gemini', 'weights', 'benchmark'] },
  { name: 'Business', keywords: ['nvidia', 'funding', 'deal', 'ipo', 'revenue', 'acquisition', 'billion', 'launch', 'business', 'market'] },
  { name: 'Hardware', keywords: ['chip', 'hardware', 'gpu', 'robots', 'humanoid', 'device', 'asics', 'tpu'] },
  { name: 'Agents', keywords: ['agent', 'harness', 'openclaw', 'codex', 'coding', 'workflow', 'grok bot', 'plugin'] },
  { name: 'Open Source', keywords: ['open source', 'open-source', 'weights', 'hugging face', 'license'] },
  { name: 'Research', keywords: ['research', 'paper', 'arxiv', 'academic', 'preview', 'iteration'] },
]

/** 从标题+URL 推断分类 */
function classifyNews(title: string, url: string): string {
  for (const c of NEWS_CATEGORIES) {
    const hit = c.keywords.some((k) => title.toLowerCase().includes(k) || url.toLowerCase().includes(k))
    if (hit) return c.name
  }
  return 'News'
}

/** RSS description 去 HTML 标签 + 去首图（<img>） → 纯文本摘要 */
function cleanSummary(desc: string): string {
  return desc
    .replace(/<img[^>]*>/gi, '') // 去首图
    .replace(/<[^>]*>/g, '')     // 去其余 HTML 标签
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
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
    const title = titleM ? (titleM[1] || titleM[2] || '').trim() : ''
    const url = linkM ? linkM[1].trim() : ''
    if (!title || !url) continue
    const date = dateM ? new Date(dateM[1].trim()).toISOString() : ''
    items.push({
      title,
      url,
      summary: cleanSummary(descM ? descM[1] : '').slice(0, 300),
      date,
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
export async function searchSupercrzyNews(opts: {
  query?: string
  category?: string
  limit?: number
}): Promise<SupercrzyNewsItem[]> {
  let items = await fetchSupercrzyNews()
  const q = (opts.query || '').trim().toLowerCase()
  if (q) items = items.filter((n) => n.title.toLowerCase().includes(q) || n.summary.toLowerCase().includes(q))
  if (opts.category && opts.category !== 'all' && opts.category !== 'News') {
    const target = opts.category.toLowerCase()
    items = items.filter((n) => n.category.toLowerCase() === target || n.title.toLowerCase().includes(target))
  }
  // 按日期倒序（最新在前）
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  return items.slice(0, opts.limit || 10)
}
