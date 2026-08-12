/**
 * Continuous Learning — 从对话中自动提取用户偏好和模式
 * ECC v2 风格的持续学习系统
 */
import { getDB } from './database'

interface LearnedInsight {
  key: string
  content: string
  confidence: number
  source: string
}

// 用户偏好模式 — 自动检测
const PREFERENCE_PATTERNS = [
  { regex: /(?:更喜欢|偏好|喜欢|常用|习惯)\s*(?:用|使用|采用)?\s*([^，。！\n]{5,30})/g, category: '偏好' },
  { regex: /(?:不要|别再|停止|避免)\s*(?:给我|使用|发送|用)?\s*([^，。！\n]{5,30})/g, category: '不喜欢' },
  { regex: /(?:我的|我们|SUPERCRZY)\s*([^是，。！\n]{5,40}?)(?:是|在|用|使用|采用|部署)/g, category: '上下文' },
  { regex: /(?:记住了|记住)\s*[,:]?\s*([^，。！\n]{5,60})/g, category: '指令' },
]

export function analyzeMessages(messages: Array<{ role: string; content: string }>, sessionId: string): LearnedInsight[] {
  const insights: LearnedInsight[] = []
  const userMessages = messages.filter(m => m.role === 'user')

  for (const msg of userMessages) {
    for (const pattern of PREFERENCE_PATTERNS) {
      let match
      while ((match = pattern.regex.exec(msg.content)) !== null) {
        const extracted = match[1].trim()
        if (extracted.length < 5) continue

        // 计算置信度：匹配越精确、越独有，分数越高
        const uniqueness = extracted.length / msg.content.length
        const confidence = Math.min(0.95, 0.4 + uniqueness * 2)

        insights.push({
          key: `learned_${pattern.category}_${Date.now()}`,
          content: extracted,
          confidence,
          source: sessionId,
        })
      }
    }
  }

  // 去重并保存到数据库
  saveInsights(deduplicate(insights))
  return deduplicate(insights)
}

function deduplicate(insights: LearnedInsight[]): LearnedInsight[] {
  const seen = new Set<string>()
  const unique: LearnedInsight[] = []
  for (const ins of insights) {
    const key = ins.content.slice(0, 30)
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(ins)
    }
  }
  // Sort by confidence descending
  return unique.sort((a, b) => b.confidence - a.confidence)
}

function saveInsights(insights: LearnedInsight[]) {
  if (insights.length === 0) return
  try {
    const db = getDB()
    for (const ins of insights) {
      // 检查是否已存在相似记录
      const existing = db.prepare(
        'SELECT id FROM agent_memory WHERE key = ?'
      ).get(ins.key) as any
      if (existing) continue

      db.prepare(
        'INSERT INTO agent_memory (key, content, importance) VALUES (?, ?, ?)'
      ).run(ins.key, JSON.stringify({ content: ins.content, confidence: ins.confidence, source: ins.source, category: 'learned' }), ins.confidence)
    }
  } catch (_) {}
}

// 提取对话摘要用于上下文压缩
export function summarizeSession(messages: Array<{ role: string; content: string }>): string {
  const userMsgs = messages.filter(m => m.role === 'user').map(m => m.content.slice(0, 200))
  const topics = new Set<string>()
  
  // Simple keyword extraction
  const keywords = /(?:AI|模型|模型|代理|Agent|技能|skill|Pipeline|部署|发布|文章|WeChat|微信|CMS|server|服务器|端口)/gi
  for (const msg of userMsgs) {
    const matches = msg.match(keywords)
    if (matches) matches.forEach(m => topics.add(m.toLowerCase()))
  }

  return `[Session Summary] Topics: ${[...topics].join(', ')}. Messages: ${userMsgs.length}.`
}
