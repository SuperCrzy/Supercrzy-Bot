/**
 * skill_search — 由注册表管理（P1-03，2026-09-17 从 services/tools.ts 迁出）
 * 定义与执行器一体：加工具 = 加一个文件，不再双写。
 */
import type { ToolDef } from './types'

const tool: ToolDef = {
    name: 'skill_search',
    description: '搜索互联网上的开源技能。当你需要的能力没有内置技能支持时使用，如 docker、deploy、lint 等。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，如 "docker deploy"、"python lint"、"react testing"' },
      },
      required: ['query'],
    },
  async execute(args) {
    const query = args.query || args.q || ''
    if (!query.trim()) return 'Usage: skill_search(query="docker deploy")'

    const searchQuery = `${query} SKILL.md agent skill github`
    try {
      const encoded = encodeURIComponent(searchQuery)
      const url = `https://www.bing.com/search?format=rss&q=${encoded}&count=8`
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUPERCRZY-BOT/1.0)', 'Accept': 'application/rss+xml' },
      })
      if (!response.ok) return `Search failed: HTTP ${response.status}`

      const xml = await response.text()
      const itemRegex = /<item>([\s\S]*?)<\/item>/g
      const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/
      const linkRegex = /<link>(.*?)<\/link>/

      const results: string[] = []
      let match
      while ((match = itemRegex.exec(xml)) !== null && results.length < 8) {
        const item = match[1]
        const titleM = item.match(titleRegex)
        const linkM = item.match(linkRegex)
        const title = titleM ? (titleM[1] || titleM[2] || '').trim() : ''
        const repoUrl = linkM ? linkM[1].trim() : ''
        if (title && repoUrl) {
          results.push(`- ${title}\n  ${repoUrl}`)
        }
      }

      if (results.length === 0) return `No skills found for "${query}". Try broader keywords.`
      return `Found ${results.length} results for "${query}":\n\n${results.join('\n\n')}\n\nUse skill_install(url="...") to install any of these.`
    } catch (err: any) {
      return `Skill search failed: ${err.message}`
    }
  },
}

export default tool
