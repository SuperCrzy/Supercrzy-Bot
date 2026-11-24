/**
 * web_search — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { parseResultDate, runSearchChain, runExhaustiveSearch, type SearchResultItem } from '../services/search-providers'

function labelDates(results: SearchResultItem[]) {
  return results.map(result => ({ ...result, date_status: Number.isNaN(parseResultDate(result.date)) ? 'unknown' : 'unverified' }))
}

const tool: ToolDef = {
    name: 'web_search',
    description: '网络搜索。返回搜索结果列表（标题/链接/摘要/日期）。用户问最新、今天或本周等时效性问题时应传 timeRange。新闻可用 source=news，但搜索结果的日期和摘要可能缺失或不准确；关键事实和日期应打开可靠来源核实，并区分发布时间与事件发生时间。无法确认的日期标注未知。',
    category: 'network',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'number', description: '返回结果数量，默认8，最大10' },
        timeRange: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '时间范围过滤：day=近24小时 / week=近1周 / month=近1月 / year=近1年。要"今天的消息"必须用 day，时效性问题至少 week。' },
        source: { type: 'string', enum: ['news'], description: '新闻搜索模式；结果的来源和日期仍需核实。' },
      },
      required: ['query'],
    },
  async execute(args) {
    // 搜索 Provider 抽象（2026-08-28 重构：从 5 层 if 嵌套改为 search-providers 插件式，见 services/search-providers.ts）
    // 优先级：Tavily → Serper → SearXNG → DeepSeek → Bing，探测→降级；新增引擎=加 provider 对象
    try {
      const query = String(args.query || '').trim()
      if (!query) return '❌ 缺少查询参数 query'
      const count = typeof args.count === 'number' && Number.isFinite(args.count) && args.count >= 1
        ? Math.min(Math.floor(args.count), 10)
        : 8
      const timeRange = ['day', 'week', 'month', 'year'].includes(args.timeRange) ? args.timeRange : ''
      const NEWS_HINTS = /新闻|今日|今天|最新|快讯|报道|发布|速递|资讯|简报|News|Breaking|Today|Latest|Headline/i
      const effectiveSource = args.source === 'news' || (NEWS_HINTS.test(query) && timeRange) ? 'news' : (args.source || '')
      const maxAgeDays = timeRange ? ({ day: 1, week: 7, month: 31, year: 365 } as Record<string, number>)[timeRange] : 0
      // 时效/news 类请求走"并行全源"更全面（DeepSeek当日+自建SearXNG+Bing 同时并行合并去重）；
      // 普通搜索走快通道（首个非空即返，省时省费）
      const wantFresh = effectiveSource === 'news' || timeRange === 'day' || timeRange === 'week'
      if (wantFresh) {
        const r = await runExhaustiveSearch({ query, count, timeRange, depth: args.depth || 'basic', source: effectiveSource, maxAgeDays })
        if (r.results.length === 0) return JSON.stringify({ results: [], query, engine: r.engine, message: '没有可用的搜索结果；可能没有匹配内容，也可能是搜索来源暂时不可用。请调整关键词或稍后重试。' })
        return JSON.stringify({ engine: r.engine, engines: r.engines, results: labelDates(r.results), query, ...(timeRange ? { date_note: 'unknown 表示日期未知，不能确认符合时间范围；unverified 表示日期尚未向原始来源核实。' } : {}) })
      }
      const { engine, results } = await runSearchChain({ query, count, timeRange, depth: args.depth || 'basic', source: effectiveSource, maxAgeDays })
      if (results.length === 0) return JSON.stringify({ results: [], query, message: '没有可用的搜索结果；可能没有匹配内容，也可能是搜索来源暂时不可用。请调整关键词或稍后重试。' })
      return JSON.stringify({ engine, results: labelDates(results), query, ...(timeRange ? { date_note: 'unknown 表示日期未知，不能确认符合时间范围；unverified 表示日期尚未向原始来源核实。' } : {}) })
    } catch (err: any) {
      return '❌ 搜索失败：' + err.message
    }
  },
}

export default tool
