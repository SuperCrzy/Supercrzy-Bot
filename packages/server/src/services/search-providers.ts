/**
 * 搜索 Provider 抽象（2026-08-28 从 tools.ts web_search 的 5 层 if 嵌套重构成插件式）。
 *
 * 设计（对齐 Hermes 插件化 WebProvider）：
 * - SearchProvider 接口：name / enabled / search
 * - 每个引擎（Tavily/Serper/SearXNG/DeepSeek/Bing）一个独立 provider 对象
 * - web_search 按优先级遍历 SEARCH_PROVIDERS，取第一个返回非空结果的引擎（探测→降级）
 * - 新增引擎：实现接口 + push 进 SEARCH_PROVIDERS，web_search 无需改动
 */

// ===================== 类型 & 工具（从 tools.ts 迁出，保证无循环依赖） =====================

export interface SearchResultItem {
  title: string
  url: string
  description?: string
  date?: string
  engine?: string
  score?: number
}

/** 搜索结果后处理：过滤空条目 + 同域名最多 2 条 + 标题相似去重 + 有日期的排前；maxAgeDays>0 时剔除超期结果 */
export function postProcessSearchResults<T extends { title: string; url: string; description?: string; date?: string }>(results: T[], limit: number, maxAgeDays = 0): T[] {
  let list = results.filter((r) => r.title && r.url && r.title !== 'Object moved')
  if (maxAgeDays > 0) {
    const cutoff = Date.now() - maxAgeDays * 86400000
    list = list.filter((r) => {
      if (!r.date) return false
      const t = Date.parse(r.date)
      return !isNaN(t) && t >= cutoff
    })
  }
  const byUrl = new Map<string, T>()
  for (const r of list) {
    const u = (r.url || '').replace(/^https?:\/\/(www\.)?/, '').split('/')[0]
    const key = `${u}:${(r.title || '').slice(0, 30)}`
    if (!byUrl.has(key)) byUrl.set(key, r)
  }
  const seen = new Map<string, number>()
  const out: T[] = []
  // 按有日期优先 + 原序
  const sorted = [...byUrl.values()].sort((a, b) => (a.date ? 1 : 0) - (b.date ? 1 : 0))
  for (const r of sorted) {
    const host = r.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]
    const hc = (seen.get(host) ?? 0) + 1
    seen.set(host, hc)
    if (hc <= 2) out.push(r)
  }
  return out.slice(0, limit)
}

/** 读取 settings 表配置（provider 内自查，避免与 tools.ts 循环依赖） */
function readSetting(key: string): string {
  try {
    const { getDB } = require('./database')
    const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row?.value ? String(row.value).trim() : ''
  } catch {
    return ''
  }
}

// ===================== Provider 接口 =====================

export interface SearchContext {
  query: string
  count: number
  /** day/week/month/year 或 '' */
  timeRange?: string
  depth?: string
  /** '' 或 'news'（新闻流） */
  source?: string
}

export interface SearchProvider {
  /** 引擎标识（返回给前端/模型展示） */
  name: string
  enabled(ctx: SearchContext): Promise<boolean>
  search(ctx: SearchContext): Promise<SearchResultItem[]>
}

/** 安全执行：失败/超时/异常一律返回空（上层据此降级下一家） */
export async function safeSearch(provider: SearchProvider, ctx: SearchContext): Promise<SearchResultItem[]> {
  try {
    return (await provider.search(ctx)) || []
  } catch {
    return []
  }
}

// ===================== 引擎实现 =====================

/** 1) Tavily：AI 优化搜索（免费 1000 次/月），relevance 过滤 */
const tavilyProvider: SearchProvider = {
  name: 'tavily',
  async enabled() { return !!readSetting('tavilyApiKey') },
  async search(ctx) {
    const key = readSetting('tavilyApiKey')
    if (!key) return []
    const rangeDays: Record<string, number> = { day: 1, week: 7, month: 31, year: 365 }
    const maxAge = ctx.timeRange ? rangeDays[ctx.timeRange] : 0
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key, query: ctx.query, max_results: ctx.count,
        search_depth: ctx.depth === 'advanced' ? 'advanced' : 'basic',
        include_answer: false,
        ...(ctx.timeRange ? { days: maxAge } : {}),
        ...(ctx.source === 'news' ? { topic: 'news' } : {}),
      }),
    })
    if (!resp.ok) return []
    const data = await resp.json() as { results?: Array<{ title: string; url: string; content: string; score?: number }> }
    return (data.results || []).map((r) => ({ title: r.title, url: r.url, description: (r.content || '').slice(0, 400), score: r.score }))
  },
}

/** 2) Serper：Google 原生结果（免费 2500 次/月，质量最好） */
const serperProvider: SearchProvider = {
  name: 'serper',
  async enabled() { return !!readSetting('serperApiKey') },
  async search(ctx) {
    const key = readSetting('serperApiKey')
    if (!key) return []
    const resp = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: ctx.query, num: ctx.count, gl: 'cn', hl: 'zh-cn', ...(ctx.timeRange ? { tbs: `qdr:${ctx.timeRange[0]}` } : {}), ...(ctx.source === 'news' ? { type: 'news' } : {}) }),
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) return []
    const data = await resp.json() as { organic?: Array<{ title: string; link: string; snippet: string; date?: string }> }
    return (data.organic || []).map((r) => ({ title: r.title, url: r.link, description: (r.snippet || '').slice(0, 300), date: r.date }))
  },
}

/** 3) SearXNG：自建开源元搜索（聚合 70+ 引擎；美国 VPS 部署最佳） */
const searxngProvider: SearchProvider = {
  name: 'searxng',
  async enabled() { return !!readSetting('searxngUrl') },
  async search(ctx) {
    const base = readSetting('searxngUrl').replace(/\/+$/, '')
    if (!base) return []
    const p = new URLSearchParams({ q: ctx.query, format: 'json', language: 'zh-CN', safesearch: '0' })
    if (ctx.source === 'news') p.set('categories', 'news')
    if (ctx.timeRange) p.set('time_range', ctx.timeRange)
    const resp = await fetch(`${base}/search?${p.toString()}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUPERCRZY-BOT/1.0)', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(12000),
    })
    if (!resp.ok) return []
    const sd = await resp.json()
    return (sd.results || []).map((r: any) => ({
      title: r.title || '', url: r.url || '',
      description: (r.content || r.snippet || '').slice(0, 300),
      date: r.publishedDate || '',
      engine: r.engine ? (Array.isArray(r.engine) ? r.engine.join(',') : String(r.engine)) : '',
    }))
  },
}

/** 4) DeepSeek 官方原生搜索（web_search_20250305，复用 DeepSeek key，零新增配置） */
const deepseekProvider: SearchProvider = {
  name: 'deepseek',
  async enabled() {
    return !!readSetting('apiKey') || !!readSetting('OPENAI_KEY') || !!readSetting('DEEPSEEK_API_KEY') || !!readSetting('deepseekApiKey')
  },
  async search(ctx) {
    const apiKey = readSetting('apiKey') || readSetting('OPENAI_KEY') || readSetting('DEEPSEEK_API_KEY') || readSetting('deepseekApiKey')
    if (!apiKey) return []
    const resp = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash', max_tokens: 512,
        messages: [{ role: 'user', content: `请使用 web_search 工具搜索：${ctx.query}` }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!resp.ok) return []
    const data = await resp.json() as any
    const results: SearchResultItem[] = []
    const seen = new Set<string>()
    for (const block of data?.content || []) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r.type === 'web_search_result' && r.url && !seen.has(r.url)) {
            seen.add(r.url)
            results.push({ title: r.title || '', url: r.url, description: '', date: r.page_age || '' })
          }
        }
      }
    }
    return results.slice(0, ctx.count)
  },
}

/** 5) Bing RSS：免费兜底（中国网络可能被 302 到 cn.bing.com 返回 0 条） */
const bingProvider: SearchProvider = {
  name: 'bing',
  async enabled() { return true },
  async search(ctx) {
    const encoded = encodeURIComponent(ctx.query)
    const resp = await fetch(`https://www.bing.com/search?format=rss&q=${encoded}&count=${ctx.count}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUPERCRZY-BOT/1.0)', 'Accept': 'application/rss+xml, application/xml, text/xml' },
      redirect: 'follow',
    })
    if (!resp.ok) return []
    const xml = await resp.text()
    if (!xml.includes('<item>')) return []
    const results: SearchResultItem[] = []
    const itemRegex = /<item>([\s\S]*?)<\/item>/g
    const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/
    const linkRegex = /<link>(.*?)<\/link>/
    const descRegex = /<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/
    const dateRegex = /<pubDate>(.*?)<\/pubDate>/
    let match
    while ((match = itemRegex.exec(xml)) !== null && results.length < ctx.count) {
      const item = match[1]
      const titleM = item.match(titleRegex)
      const linkM = item.match(linkRegex)
      const descM = item.match(descRegex)
      const dateM = item.match(dateRegex)
      const title = titleM ? (titleM[1] || titleM[2] || '').trim() : ''
      const url = linkM ? linkM[1].trim() : ''
      const desc = descM ? (descM[1] || descM[2] || '').trim().replace(/<[^>]*>/g, '') : ''
      const date = dateM ? dateM[1].trim() : ''
      if (title && url) results.push({ title, url, description: desc.slice(0, 300), date })
    }
    return results
  },
}

/** 启用顺序 = 数组顺序（优先级：Tavily → Serper → SearXNG → DeepSeek → Bing） */
export const SEARCH_PROVIDERS: SearchProvider[] = [
  tavilyProvider, serperProvider, searxngProvider, deepseekProvider, bingProvider,
]

/**
 * 按优先级遍历 provider，返回第一个产出非空结果的引擎。
 * 返回值：{ engine, results(已后处理), 空=全失败/无结果 }
 */
export async function runSearchChain(
  ctx: SearchContext & { maxAgeDays?: number },
): Promise<{ engine: string; results: SearchResultItem[] }> {
  const count = ctx.count || 8
  const maxAge = ctx.maxAgeDays || (ctx.timeRange ? ({ day: 1, week: 7, month: 31, year: 365 } as Record<string, number>)[ctx.timeRange] : 0) || 0
  for (const provider of SEARCH_PROVIDERS) {
    if (!(await provider.enabled(ctx))) continue
    const raw = await safeSearch(provider, ctx)
    if (raw.length > 0) {
      // 不同引擎返回的字段略有差异；raw 已是标准化 SearchResultItem
      return { engine: provider.name, results: postProcessSearchResults(raw as any, count, maxAge) }
    }
  }
  return { engine: 'none', results: [] }
}
