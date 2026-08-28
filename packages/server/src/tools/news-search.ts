/**
 * news_search — 检索 supercrzy.com AI 新闻（新闻生态联动核心工具，2026-08-28 加）。
 *
 * 区别于 web_search（抓全网）：news_search 只检索 supercrzy.com/feed.xml 自有内容源，
 * 自带精确发布日期 → 时效性天然准，适合"最近 AI 动态 / 某方向进展"类查询。
 * 模型在对话里问 AI 新闻时优先走它；返回结构化条目（标题/链接/日期/摘要/分类）。
 *
 * 联动（供模型理解何时用）：
 * - 用户问"最近/今日/最新 AI 新闻/模型/硬件/Agent 动态" → 调 news_search
 * - 返回后，若某条值得深挖 → 可进一步 deep_research（交叉全网深挖）
 */
import type { ToolDef } from './types'
import { searchSupercrzyNews, type SupercrzyNewsItem } from '../services/supercrzy-feed'
import { getDB } from '../services/database'

/** 查询用户长期关注方向（category='topic' 记忆内容） */
function readTopicMemories(): string[] {
  try {
    const rows = getDB()
      .prepare("SELECT content FROM agent_memory WHERE category = 'topic' ORDER BY importance DESC LIMIT 10")
      .all() as Array<{ content: string }>
    return rows.map((r) => r.content).filter(Boolean).map((c) => c.slice(0, 60))
  } catch {
    return []
  }
}

/** 判断新闻是否命中某个关注方向（词干匹配关键词） */
function highlightTopics(item: SupercrzyNewsItem, topics: string[]): string[] {
  const hay = `${item.title} ${item.summary}`.toLowerCase()
  const hits: string[] = []
  for (const t of topics) {
    // 取关注方向里的关键名词片段（去掉"关注/对...感兴趣"等虚词）做包含匹配
    const keywords = t.replace(/我(?:关注|对|在做|研究).*?[：:]/g, '').replace(/关注|感兴趣|方向/g, ' ').match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) || []
    if (keywords.some((k) => hay.includes(k.toLowerCase()))) hits.push(t)
  }
  return hits
}
function formatNews(item: SupercrzyNewsItem, i: number): string {
  const date = item.date ? new Date(item.date).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '日期未知'
  const cat = item.category ? `[${item.category}]` : ''
  return `${i + 1}. ${cat} ${date} ${item.title}\n   ${item.url}\n   ${item.summary || '（无摘要）'}`
}

const newsSearchTool: ToolDef = {
  name: 'news_search',
  description:
    '检索 SUPERCRZY 自有 AI 新闻库（supercrzy.com，实时更新）：模型/商业/硬件/Agent/开源/研究分类，条目自带精确发布日期。' +
    '用户问最近/今日/最新 AI 新闻、某方向（如"推理成本""某模型进展"）动态时调用，返回按日期倒序的新闻列表（标题/链接/日期/摘要/分类）。' +
    '搭配 deep_research 可对某条新闻做交叉全网深度挖掘。',
  category: 'system',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词（可选，标题/摘要匹配；空 = 返回最新新闻）' },
      category: { type: 'string', description: '分类过滤：Models / Business / Hardware / Agents / Open Source / Research / all/空 = 不限' },
      limit: { type: 'number', description: '返回条数（默认 5，最多 15）' },
    },
  },
  async execute(args: any, ctx?: any) {
    const limit = Math.min(Number(args.limit) || 5, 15)
    const category = String(args.category || '').trim()
    const query = String(args.query || '').trim()
    const items = await searchSupercrzyNews({ query, category, limit })
    if (items.length === 0) {
      return query
        ? `未在 SUPERCRZY 新闻库中找到与 "${query}" 相关的最新内容。可用 web_search 做全网搜索兜底。`
        : 'SUPERCRZY 新闻库当前无条目（源站可能暂时不可达）。可稍后重试或转 web_search。'
    }
    // ==== 联动：标注命中用户关注方向（category='topic' 记忆），实现"消费→记忆"闭环（2026-08-28 加）====
    const topics = readTopicMemories()
    const head = query
      ? `SUPERCRZY 新闻库检索 "${query}"（${category || '全部分类'}）命中 ${items.length} 条：\n`
      : `SUPERCRZY 最新 AI 新闻（${items.length} 条，按日期倒序）：\n`
    let body = items.map((it, i) => {
      const hits = highlightTopics(it, topics)
      const tag = hits.length > 0 ? ` 🔥命中你关注的：${hits.slice(0, 2).join('、')}` : ''
      return formatNews(it, i) + tag
    }).join('\n\n')
    // 若命中关注方向，顶部额外提示（强化主动性）
    if (topics.length > 0) {
      body = `（记得你关注的：${topics.slice(0, 3).join('；')}）\n` + body
    }
    return head + body
  },
}

export default newsSearchTool
