/**
 * 搜索 Provider 抽象（2026-08-28 从 tools.ts web_search 的 5 层 if 嵌套重构成插件式）。
 *
 * 设计（对齐 Hermes 插件化 WebProvider）：
 * - SearchProvider 接口：name / enabled / search
 * - 每个引擎（Tavily/Serper/SearXNG/DeepSeek/Bing）一个独立 provider 对象
 * - web_search 按优先级遍历 SEARCH_PROVIDERS，取第一个返回非空结果的引擎（探测→降级）
 * - 新增引擎：实现接口 + push 进 SEARCH_PROVIDERS，web_search 无需改动
 */
import { getDB } from './database'

// ===================== 类型 & 工具（从 tools.ts 迁出，保证无循环依赖） =====================

export interface SearchResultItem {
  title: string
  url: string
  description?: string
  date?: string
  engine?: string
  score?: number
}

/**
 * Parse a result date, tolerating the formats search engines actually return.
 *
 * Date.parse handles RFC 1123 ("Mon, 23 Nov 2026 05:46:00 GMT") but returns NaN for
 * the localized form Bing emits in a Chinese locale ("周一, 23 11月 2026 05:46:00 GMT").
 * That NaN made the maxAgeDays filter drop every result, so a timeRange query came
 * back empty while the same query without one returned five rows. Not an empty date
 * field — an unparseable one.
 */
const CN_MONTHS: Record<string, number> = {
  '1月': 0, '2月': 1, '3月': 2, '4月': 3, '5月': 4, '6月': 5,
  '7月': 6, '8月': 7, '9月': 8, '10月': 9, '11月': 10, '12月': 11,
}

export function parseResultDate(raw: string | undefined): number {
  if (!raw) return NaN
  const direct = Date.parse(raw)
  if (!isNaN(direct)) return direct

  // "周一, 23 11月 2026 05:46:00 GMT" — weekday is irrelevant, month is localized.
  const m = raw.match(/(\d{1,2})\s*([^\s,]+月)\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (m) {
    const day = Number(m[1])
    const month = CN_MONTHS[m[2]]
    const year = Number(m[3])
    if (month !== undefined) {
      const t = Date.UTC(year, month, day, Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0))
      return isNaN(t) ? NaN : t
    }
  }
  // "2026年11月23日" and "2026-11-23" both survive this.
  const cn = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (cn) return Date.UTC(Number(cn[1]), Number(cn[2]) - 1, Number(cn[3]))
  return NaN
}

/** 搜索结果后处理：过滤空条目 + 同域名最多 2 条 + 标题相似去重 + 有日期的排前；maxAgeDays>0 时剔除超期结果 */
export function postProcessSearchResults<T extends { title: string; url: string; description?: string; date?: string }>(results: T[], limit: number, maxAgeDays = 0, maxPerHost = 2): T[] {
  let list = results.filter((r) => r && typeof r.title === 'string' && typeof r.url === 'string' && r.title && r.url && r.title !== 'Object moved')
  if (maxAgeDays > 0) {
    const cutoff = Date.now() - maxAgeDays * 86400000
    // Drop what is provably too old. Keep what cannot be dated.
    //
    // This used to drop undated results too, on the reasoning that a missing date
    // cannot prove freshness. The effect was worse than the risk: asking for "today"
    // returned only the sources that happen to publish dates, and a query whose
    // engines all omit them came back empty — the user is told there is no news when
    // there is news without timestamps. Undated rows are now kept and sorted last
    // (see the comparator), and the tool description tells the model to label them
    // "date unknown" instead of presenting them as current.
    list = list.filter((r) => {
      const t = parseResultDate(r.date)
      return isNaN(t) || t >= cutoff
    })
  }
  // Full normalized headlines avoid conflating different stories with a shared prefix.
  const urlsSeen = new Set<string>()
  const titleSeen = new Set<string>()
  const seen = new Map<string, number>()
  const out: T[] = []
  // 按有日期优先 + 原序
  // Dated first, then newest first among those.
  //
  // The previous comparator only checked whether a date *exists*
  // (isFinite(b) - isFinite(a)), which is 0 for two dated rows — so results kept
  // whatever order the provider returned and "sorted by date" was not true. Compare
  // the timestamps; undated rows sort last and keep their relative order.
  const sorted = [...list].sort((a, b) => {
    const ta = parseResultDate(a.date)
    const tb = parseResultDate(b.date)
    const na = Number.isNaN(ta), nb = Number.isNaN(tb)
    if (na && nb) return 0
    if (na) return 1
    if (nb) return -1
    return tb - ta
  })
  for (const r of sorted) {
    let urlKey = r.url, host = r.url
    try { const url = new URL(r.url); url.hash = ''; urlKey = url.toString(); host = url.hostname.replace(/^www\./, '') } catch { /* preserve malformed URLs as distinct */ }
    const titleKey = r.title.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '')
    if (urlsSeen.has(urlKey) || (titleKey && titleSeen.has(titleKey)) || (seen.get(host) ?? 0) >= maxPerHost) continue
    urlsSeen.add(urlKey)
    if (titleKey) titleSeen.add(titleKey)
    seen.set(host, (seen.get(host) ?? 0) + 1)
    out.push(r)
  }
  return out.slice(0, limit)
}

/**
 * Read a value from the settings table.
 *
 * Fixed 2026-11-19 (measured P0): this used to be `require('./database')`. The
 * package is "type": "module", so ESM has no require - it threw
 * ERR_UNSUPPORTED_DIR_IMPORT (directory import + missing extension), the catch
 * below swallowed it into '', and every keyed engine was therefore judged
 * "unconfigured" (measured: deepseek/searxng/tavily/serper all false, leaving
 * only bing, which needs no key). The DB did hold apiKey and searxngUrl; users
 * still only ever saw bing results.
 *
 * Now a static import. There is no cycle: database.ts does not import this file.
 * The catch stays (enabled() must not blow up at boot when the DB is not ready)
 * but it logs - swallowing the error silently is why this survived so long.
 */
function readSetting(key: string): string {
  try {
    const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row?.value ? String(row.value).trim() : ''
  } catch (error) {
    console.warn('[search] readSetting failed (is the DB initialized?):', key, error instanceof Error ? error.message : error)
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
      signal: AbortSignal.timeout(10000),
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


/**
 * Query one SearXNG instance. Returns [] on any failure so the caller can
 * fall back to the other instance.
 */
/**
 * Instances that recently failed are skipped for a while. Without this, a dead
 * instance costs the full timeout on EVERY search (measured: a cross-border
 * instance that answers in 10s locally hangs for 30s from outside, then the
 * caller waits again on the fallback).
 */
const DEAD_INSTANCES = new Map<string, number>()
const DEAD_TTL_MS = 60_000

async function querySearxng(base: string, ctx: SearchContext, timeoutMs = 8000): Promise<SearchResultItem[]> {
  const deadUntil = DEAD_INSTANCES.get(base) || 0
  if (Date.now() < deadUntil) return []
  const p = new URLSearchParams({ q: ctx.query, format: 'json', safesearch: '0' })
  if (ctx.source === 'news') p.set('categories', 'news')
  // time_range is a native SearXNG parameter: the upstream engines do the
  // filtering. Do NOT re-filter locally by maxAgeDays afterwards - these
  // engines return no publishedDate, so a local filter would drop every row.
  if (ctx.timeRange) p.set('time_range', ctx.timeRange)
  p.set('language', /[\u4e00-\u9fff]/.test(ctx.query) ? 'zh-CN' : 'en')
  try {
    const resp = await fetch(`${base}/search?${p.toString()}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUPERCRZY-BOT/1.0)', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resp.ok) { DEAD_INSTANCES.set(base, Date.now() + DEAD_TTL_MS); return [] }
    const sd: any = await resp.json()
    DEAD_INSTANCES.delete(base)
    return (sd.results || []).map((r: any) => ({
      title: r.title || '', url: r.url || '',
      description: (r.content || r.snippet || '').slice(0, 300),
      date: r.publishedDate || '',
      engine: r.engine ? (Array.isArray(r.engine) ? r.engine.join(',') : String(r.engine)) : '',
    })) as SearchResultItem[]
  } catch {
    // Timeout / network failure: mark it dead so the next search does not pay
    // this timeout again, then let the caller try the other instance.
    DEAD_INSTANCES.set(base, Date.now() + DEAD_TTL_MS)
    return []
  }
}

/** Test hook: module-level state is shared by design. */
export function resetDeadInstances(): void { DEAD_INSTANCES.clear() }

/** 3) SearXNG: self-hosted meta-search (aggregates 70+ engines) */
const searxngProvider: SearchProvider = {
  name: 'searxng',
  async enabled() { return !!readSetting('searxngUrl') },
  async search(ctx) {
    // Self-hosted instances (2026-11-19, reconciled after measurement):
    //   searxngUrl       - the PRIMARY instance. Currently the overseas one
    //                      (107.174.107.199:8080, Google/Brave/DDG upstreams,
    //                      answers in ~1s and returns 20 rows).
    //   searxngUrlGlobal - optional secondary. Kept as a distinct key so the
    //                      mainland instance (116.181.17.27, 360search) can be
    //                      promoted later — after ICP filing it becomes
    //                      reachable over 443 with a domain. It answers 200
    //                      locally but times out from outside mainland China,
    //                      so it must not be the default while unfiled.
    // Both are tried; the query language only decides the order.
    const primary = readSetting('searxngUrl').replace(/\/+$/, '')
    const secondary = readSetting('searxngUrlGlobal').replace(/\/+$/, '')
    const hasCJK = /[\u4e00-\u9fff]/.test(ctx.query)
    const ordered = hasCJK ? [secondary, primary] : [primary, secondary]
    const bases = ordered.filter((b, i) => b && ordered.indexOf(b) === i)
    if (!bases.length) return []
    for (const base of bases) {
      // Shorter budget for the first attempt so a dead instance cannot eat the
      // whole request: 6s, then 12s for the fallback (it must actually answer).
      const timeoutMs = base === bases[0] ? 6000 : 12000
      const rows = await querySearxng(base, ctx, timeoutMs)
      if (rows.length) return rows
    }
    return []
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
    // www.bing.com answers with a 302 to its regional host. Letting fetch follow
    // automatically can bounce several times and end in a redirect loop, which
    // surfaced as "Bing silently returns nothing" while it was the only
    // fallback left. Follow exactly one hop by hand instead.
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (compatible; SUPERCRZY-BOT/1.0)',
      'Accept': 'application/rss+xml, application/xml, text/xml',
    }
    const url = `https://www.bing.com/search?format=rss&q=${encoded}&count=${ctx.count}`
    const signal = AbortSignal.timeout(10000)
    let resp = await fetch(url, { headers, redirect: 'manual', signal })
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location')
      if (!location) return []
      const next = location.startsWith('http') ? location : `https://www.bing.com${location}`
      if (next === url) return []
      resp = await fetch(next, { headers, redirect: 'manual', signal })
      if (resp.status >= 300) return []
    }
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

/**
 * 启用顺序（fast 串行首个非空即返）。
 * 对 news/当日请求，DeepSeek 官方搜索能给出当日结果且自带日期，故提到最前；
 * SearXNG(自建,聚合Google,免费)紧跟，Bing 纯兜底。Tavily/Serper 需付费 key 缺失即 disabled。
 */
export const SEARCH_PROVIDERS: SearchProvider[] = [
  // deepseek is intentionally NOT in the chain: it bills per search call
  // (CNY 5 / 1000) and the self-hosted SearXNG instances outperform it on
  // every measured axis (latency 0.2-1.2s vs 5.3s, 20 rows vs 8, better
  // sources). It stays defined below so it can be re-enabled explicitly.
  searxngProvider, bingProvider, tavilyProvider, serperProvider,
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
    let enabled = false
    try { enabled = await provider.enabled(ctx) } catch { /* try the next provider */ }
    if (!enabled) continue
    const raw = await safeSearch(provider, ctx)
    if (raw.length > 0) {
      // SearXNG rows carry no publishedDate (its engines do not expose one),
      // but `time_range` was already applied server-side, so re-filtering by
      // age here would drop the entire result set. Skip the local age filter
      // for it and rely on the upstream filter.
      const effectiveMaxAge = provider.name === 'searxng' ? 0 : maxAge
      const results = postProcessSearchResults(raw as any, count, effectiveMaxAge)
      if (results.length) return { engine: provider.name, results }
    }
  }
  return { engine: 'none', results: [] }
}

/**
 * 并行全源搜索（news/当日/深度调研用，2026-09-03 加）。
 * Promise.all 同时跑全部 enabled 免费源(DeepSeek官方/SearXNG自建/Bing)，各自失败自动降级为空，
 * 合并全部 → 去重 → 按"有日期最新优先"排序 → 前 count 条。
 * engine 记为一个"多源合并"聚合标识，前端可展示来源分布。
 */
export async function runExhaustiveSearch(
  ctx: SearchContext & { maxAgeDays?: number },
): Promise<{ engine: string; results: SearchResultItem[]; engines: string[] }> {
  const count = ctx.count || 8
  const maxAge = ctx.maxAgeDays || (ctx.timeRange ? ({ day: 1, week: 7, month: 31, year: 365 } as Record<string, number>)[ctx.timeRange] : 0) || 0
  const enabled: SearchProvider[] = []
  for (const p of SEARCH_PROVIDERS) {
    let on = false
    try { on = await p.enabled(ctx) } catch { on = false }
    if (on) enabled.push(p)
  }
  if (enabled.length === 0) return { engine: 'none', results: [], engines: [] }

  // 并行调用全部 enabled 源；每源给 15s 上限，慢源自动判空不等，快的先回合并
  function withTimeout<T>(pr: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((res, rej) => {
      const t = setTimeout(() => rej(new Error('search-timeout')), ms)
      pr.then((v) => { clearTimeout(t); res(v) }, (e) => { clearTimeout(t); rej(e) })
    })
  }
  const settled = await Promise.all(enabled.map(async (p) => {
    try { const raw = await withTimeout(safeSearch(p, ctx), 15000); return { name: p.name, raw } }
    catch { return { name: p.name, raw: [] } }
  }))
  const all: SearchResultItem[] = settled.flatMap((s) => s.raw)

  // Use the same date and duplicate rules as ordinary search, with a wider host cap.
  const merged = postProcessSearchResults(all, count, maxAge, 3)

  if (merged.length === 0) return { engine: 'none', results: [], engines: [] }
  return { engine: `multi(${settled.filter((s) => s.raw.length).map((s) => s.name).join('+')})`, results: merged, engines: settled.filter((s) => s.raw.length).map((s) => s.name) }
}
