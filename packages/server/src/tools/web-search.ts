/**
 * web_search — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'
import { getDB } from '../services/database'
import { randomUUID } from 'crypto'
import { join, basename } from 'path'
import { readFile, writeFile, access, appendFile, stat, readdir, rm, rmdir } from 'fs/promises'
import { exec, execFile, spawn } from 'child_process'
import { constants, readdirSync, statSync } from 'fs'
import { runSearchChain, runExhaustiveSearch } from '../services/search-providers'
import { memoryRankedSearch, memoryRankedSearchHybrid } from '../services/memory-search'
import { installSkillFromGitHub, initSkillsDirectory } from '../services/skill-loader'
import { terminalOpen, terminalList, terminalSend, terminalRead, terminalSignal, terminalClose } from '../services/terminal-manager'
import { scanDangerousPath, sandboxify, WORKSPACE_ROOT, assertSafeFilePath } from '../services/sandbox'

const tool: ToolDef = {
    name: 'web_search',
    description: '网络搜索。返回搜索结果列表（标题/链接/摘要/日期）。**用户问"最新/今天/本周"等时效性问题时必须调用并传 timeRange，不要凭训练数据回答过时信息。** 新闻/时效类问题用 source=news（新闻流，结果带精确发布日期）→ 直接按日期筛选即可，**不要逐个打开网页核实发布日期**；结果中 date 为空的条目标注"日期未知"即可。',
    category: 'network',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'number', description: '返回结果数量，默认8，最大10' },
        timeRange: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '时间范围过滤：day=近24小时 / week=近1周 / month=近1月 / year=近1年。要"今天的消息"必须用 day，时效性问题至少 week。' },
        source: { type: 'string', enum: ['news'], description: '新闻流模式：只搜新闻媒体，结果带精确发布日期（时效性问题推荐使用，省去逐条核实）。' },
      },
      required: ['query'],
    },
  async execute(args) {
    // 搜索 Provider 抽象（2026-08-28 重构：从 5 层 if 嵌套改为 search-providers 插件式，见 services/search-providers.ts）
    // 优先级：Tavily → Serper → SearXNG → DeepSeek → Bing，探测→降级；新增引擎=加 provider 对象
    try {
      const query = String(args.query || '').trim()
      if (!query) return '❌ 缺少查询参数 query'
      const count = Math.min(args.count || 8, 10)
      const timeRange = ['day', 'week', 'month', 'year'].includes(args.timeRange) ? args.timeRange : ''
      const NEWS_HINTS = /新闻|今日|今天|最新|快讯|报道|发布|速递|资讯|简报|News|Breaking|Today|Latest|Headline/i
      const effectiveSource = args.source === 'news' || (NEWS_HINTS.test(query) && timeRange) ? 'news' : (args.source || '')
      const maxAgeDays = timeRange ? ({ day: 1, week: 7, month: 31, year: 365 } as Record<string, number>)[timeRange] : 0
      // 时效/news 类请求走"并行全源"更全面（DeepSeek当日+自建SearXNG+Bing 同时并行合并去重）；
      // 普通搜索走快通道（首个非空即返，省时省费）
      const wantFresh = effectiveSource === 'news' || timeRange === 'day' || timeRange === 'week'
      if (wantFresh) {
        const r = await runExhaustiveSearch({ query, count, timeRange, depth: args.depth || 'basic', source: effectiveSource, maxAgeDays })
        if (r.results.length === 0) return JSON.stringify({ results: [], query, engine: r.engine, message: '未找到关于 "' + query + '" 的搜索结果。' })
        return JSON.stringify({ engine: r.engine, engines: r.engines, results: r.results, query })
      }
      const { engine, results } = await runSearchChain({ query, count, timeRange, depth: args.depth || 'basic', source: effectiveSource, maxAgeDays })
      if (results.length === 0) return JSON.stringify({ results: [], query, message: '未找到关于 "' + query + '" 的搜索结果。' })
      return JSON.stringify({ engine, results, query })
    } catch (err: any) {
      return '❌ 搜索失败：' + err.message
    }
  },
}

export default tool
