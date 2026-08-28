// P1 Deep Research Engine —— 移植 dzhng/deep-research(⭐19.6k MIT)循环(2026-08-23)
// 差异点：
//  - firecrawl.search → 我们五层搜索链(webSearchChain, Tavily→Serper→SearXNG→Bing→DDG)
//  - generateObject(ai/zod) → DeepSeek JSON mode + 手写容错解析(不引入新依赖)
//  - p-limit → 手写 mapLimit 并发控制(ConcurrencyLimit=2)
// 核心循环：generateSerpQueries → 并行搜索 → processSerpResult(learnings+followUpQuestions)
//           → 递归下钻(breadth 减半漏斗, 总查询 6-9 次不指数爆炸) → writeFinalReport(3+ 页 + Sources)

import { config } from '../config/index.js'
import { getDB } from './database.js'

export interface DeepResearchProgress {
  currentDepth: number
  totalDepth: number
  currentBreadth: number
  totalBreadth: number
  currentQuery?: string
  totalQueries: number
  completedQueries: number
}

export interface DeepResearchResult {
  learnings: string[]
  visitedUrls: string[]
  report: string
}

interface SerpQuery {
  query: string
  researchGoal: string
}

const CONCURRENCY = 2
const MAX_CONTENT_CHARS = 25000

function readSetting(key: string): string {
  try {
    const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row?.value ? String(row.value).trim() : ''
  } catch {
    return ''
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, '')
}

function getLLMConfig() {
  const apiKey = readSetting('apiKey') || config.deepseek.apiKey
  const model = readSetting('model') || config.deepseek.defaultModel
  const baseUrl = normalizeBaseUrl(readSetting('baseUrl') || config.deepseek.baseUrl)
  return { apiKey, model, baseUrl }
}

/** LLM JSON 结构化输出（DeepSeek JSON mode + 容错解析） */
async function llmJson(system: string, user: string, fallback: unknown): Promise<any> {
  const { apiKey, model, baseUrl } = getLLMConfig()
  if (!apiKey) throw new Error('Deep Research 需要 API Key（请在设置中配置）')
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: `${system}\n\n你只能输出一个合法的 JSON 对象，不要输出任何其他文字，不要用代码块围栏。` },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(180000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`LLM ${resp.status}: ${errText.slice(0, 200)}`)
  }
  const data = await resp.json() as any
  const text = data?.choices?.[0]?.message?.content || ''
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    if (parsed && typeof parsed === 'object') return parsed
    throw new Error('non-object')
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/)
    if (m) {
      try { return JSON.parse(m[0]) } catch { /* fallthrough */ }
    }
    return fallback
  }
}

const RESEARCH_SYSTEM = `You are a meticulous AI researcher. You gather information by searching and reading, then produce dense, factual, source-backed findings. Prefer authoritative sources. Never fabricate facts, URLs or dates. If information is missing, say so.`

/** 生成 SERP 查询（含 researchGoal 下钻方向） */
async function generateSerpQueries(query: string, learnings: string[], numQueries: number): Promise<SerpQuery[]> {
  const user = `Given the following prompt from the user, generate a list of SERP queries to research the topic. Return a maximum of ${numQueries} queries, but feel free to return less if the original prompt is clear. Make sure each query is unique and not similar to each other.
<prompt>${query}</prompt>
${learnings.length ? `\nHere are some learnings from previous research, use them to generate more specific queries: ${learnings.join('\n')}` : ''}
Return JSON: {"queries": [{"query": "the SERP query", "researchGoal": "goal of the research this query accomplishes + how to advance once results are found + additional research directions, as specific as possible"}]}`
  const res = await llmJson(RESEARCH_SYSTEM, user, { queries: [{ query, researchGoal: `Research: ${query}` }] })
  const queries = Array.isArray(res.queries)
    ? res.queries
        .filter((q: any) => q?.query)
        .map((q: any) => ({
          query: String(q.query).slice(0, 200),
          researchGoal: String(q.researchGoal || '').slice(0, 500),
        }))
    : []
  return queries.slice(0, numQueries)
}

/** 提炼搜索结果 → learnings + followUpQuestions */
async function processSerpResult(
  query: string,
  contents: string[],
  numLearnings: number,
  numFollowUp: number,
): Promise<{ learnings: string[]; followUpQuestions: string[] }> {
  // 无内容可提炼 → 短路返回，避免无意义的 LLM 调用
  if (contents.length === 0) return { learnings: [], followUpQuestions: [] }
  const user = `Given the following contents from a SERP search for the query <query>${query}</query>, generate a list of learnings from the contents. Return a maximum of ${numLearnings} learnings, but feel free to return less if the contents are clear. Make sure each learning is unique and not similar to each other. The learnings should be concise and to the point, as detailed and information dense as possible. Include entities (people, places, companies, products, things) and any exact metrics, numbers, or dates. The learnings will be used to research the topic further.
<contents>${contents.slice(0, 5).map((c) => `<content>\n${c.slice(0, MAX_CONTENT_CHARS)}\n</content>`).join('\n')}</contents>
Return JSON: {"learnings": ["..."], "followUpQuestions": ["..."]}`
  const res = await llmJson(RESEARCH_SYSTEM, user, { learnings: [], followUpQuestions: [] })
  return {
    learnings: Array.isArray(res.learnings) ? res.learnings.map(String).slice(0, numLearnings) : [],
    followUpQuestions: Array.isArray(res.followUpQuestions) ? res.followUpQuestions.map(String).slice(0, numFollowUp) : [],
  }
}

/** 生成最终报告（3+ 页 Markdown + Sources） */
async function writeFinalReport(prompt: string, learnings: string[], visitedUrls: string[]): Promise<string> {
  const user = `Given the following prompt from the user, write a final report on the topic using the learnings from research. Make it as detailed as possible, aim for 3 or more pages, include ALL the learnings from research. Write the report in the SAME LANGUAGE as the prompt (Chinese if the prompt is Chinese).
<prompt>${prompt}</prompt>
<learnings>${learnings.map((l) => `<learning>\n${l}\n</learning>`).join('\n')}</learnings>
Return JSON: {"reportMarkdown": "the full report in Markdown"}`
  const res = await llmJson(RESEARCH_SYSTEM, user, { reportMarkdown: learnings.map((l) => `- ${l}`).join('\n') })
  const report = String(res.reportMarkdown || '')
  const urlsSection = `\n\n## Sources\n\n${[...new Set(visitedUrls)].map((u) => `- ${u}`).join('\n')}`
  return report + urlsSection
}

/** 并发限制 map（p-limit 手写版） */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

/** 深度研究主循环（递归下钻） */
export async function deepResearch(opts: {
  query: string
  breadth: number
  depth: number
  learnings?: string[]
  visitedUrls?: string[]
  onProgress?: (p: DeepResearchProgress) => void
}): Promise<{ learnings: string[]; visitedUrls: string[] }> {
  const { query, breadth, depth, learnings = [], visitedUrls = [], onProgress } = opts
  const progress: DeepResearchProgress = {
    currentDepth: depth,
    totalDepth: depth,
    currentBreadth: breadth,
    totalBreadth: breadth,
    totalQueries: 0,
    completedQueries: 0,
  }
  const report = (u: Partial<DeepResearchProgress>) => onProgress?.(Object.assign({}, progress, u))

  const serpQueries = await generateSerpQueries(query, learnings, breadth)
  report({ totalQueries: serpQueries.length, currentQuery: serpQueries[0]?.query })

  const results = await mapLimit(serpQueries, CONCURRENCY, async (serpQuery) => {
    try {
      const { webSearchChain } = await import('./tools.js')
      const search = await webSearchChain(serpQuery.query, { count: 8, timeRange: depth >= 2 ? 'month' : '' })
      const searchResults = search.results || []
      const newUrls = searchResults.map((r) => r.url).filter(Boolean)
      const contents = searchResults.map((r) => r.description || '').filter(Boolean)
      const newBreadth = Math.max(1, Math.ceil(breadth / 2))
      const newDepth = depth - 1

      const { learnings: newLearnings, followUpQuestions } = await processSerpResult(serpQuery.query, contents, 3, newBreadth)
      const allLearnings = [...learnings, ...newLearnings]
      const allUrls = [...visitedUrls, ...newUrls]

      if (newDepth > 0) {
        report({
          currentDepth: newDepth,
          currentBreadth: newBreadth,
          completedQueries: progress.completedQueries + 1,
          currentQuery: serpQuery.query,
        })
        const nextQuery = `Previous research goal: ${serpQuery.researchGoal}\nFollow-up research directions: ${followUpQuestions.map((q) => `\n${q}`).join('')}`.trim()
        return deepResearch({
          query: nextQuery,
          breadth: newBreadth,
          depth: newDepth,
          learnings: allLearnings,
          visitedUrls: allUrls,
          onProgress,
        })
      }
      report({
        currentDepth: 0,
        completedQueries: progress.completedQueries + 1,
        currentQuery: serpQuery.query,
      })
      return { learnings: allLearnings, visitedUrls: allUrls }
    } catch (e: any) {
      console.log(`[DeepResearch] 查询失败 ${serpQuery.query}: ${e?.message || e}`)
      return { learnings: [...learnings], visitedUrls: [...visitedUrls] }
    }
  })

  return {
    learnings: [...new Set(results.flatMap((r) => r.learnings))],
    visitedUrls: [...new Set(results.flatMap((r) => r.visitedUrls))],
  }
}

/** 顶层入口：研究 + 最终报告 */
export async function runDeepResearch(opts: {
  query: string
  breadth?: number
  depth?: number
  onProgress?: (p: DeepResearchProgress) => void
}): Promise<DeepResearchResult> {
  const breadth = Math.min(Math.max(opts.breadth || 4, 2), 6)
  const depth = Math.min(Math.max(opts.depth || 2, 1), 3)
  const { learnings, visitedUrls } = await deepResearch({
    query: opts.query,
    breadth,
    depth,
    onProgress: opts.onProgress,
  })
  const report = await writeFinalReport(opts.query, learnings, visitedUrls)
  return { learnings, visitedUrls, report }
}
