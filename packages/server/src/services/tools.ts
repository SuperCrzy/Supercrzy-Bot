/**
 * Agent 工具定义与执行器
 * 每个工具包含 OpenAI Function Calling 格式的 schema 和执行函数
 */
import { getDB } from './database'
import { randomUUID } from 'crypto'
import { readFile, writeFile, access } from 'fs/promises'
import { exec } from 'child_process'
import { constants } from 'fs'

// ============================
// 类型定义
// ============================

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, any>
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ToolResult {
  tool_call_id: string
  role: 'tool'
  content: string
}

// ============================
// 工具执行器
// ============================

type ToolExecutor = (args: Record<string, any>) => Promise<string>

const toolExecutors: Record<string, ToolExecutor> = {
  // ---- 记忆工具 ----
  async memory_store(args) {
    const db = getDB()
    const id = randomUUID()
    db.prepare(
      'INSERT INTO agent_memory (id, key, content, category, importance) VALUES (?, ?, ?, ?, ?)'
    ).run(id, args.key, args.content, args.category || 'general', args.importance || 3)
    return `✅ 记忆已存储：${args.key}`
  },

  async memory_recall(args) {
    const db = getDB()
    const rows = db.prepare(
      `SELECT key, content, category, importance FROM agent_memory
       WHERE key LIKE ? OR content LIKE ?
       ORDER BY importance DESC LIMIT ?`
    ).all(`%${args.query}%`, `%${args.query}%`, args.limit || 5) as any[]
    if (rows.length === 0) return '未找到相关记忆。'
    return rows.map((r: any) => `[${r.key}] (重要性:${r.importance}) ${r.content}`).join('\n')
  },

  async memory_list(_args) {
    const db = getDB()
    const rows = db.prepare(
      'SELECT key, content, category, importance FROM agent_memory ORDER BY importance DESC LIMIT 20'
    ).all() as any[]
    if (rows.length === 0) return '目前没有任何记忆。'
    return rows.map((r: any) => `[${r.key}] (${r.category}, 重要性:${r.importance}) ${r.content}`).join('\n')
  },

  // ---- 文件工具 ----
  async file_read(args) {
    try {
      const content = await readFile(args.path, 'utf-8')
      // 限制长度
      const maxLen = args.maxLength || 10000
      if (content.length > maxLen) {
        return content.slice(0, maxLen) + `\n\n... (文件共 ${content.length} 字符，仅显示前 ${maxLen} 字符)`
      }
      return content
    } catch (err: any) {
      return `❌ 读取文件失败：${err.message}`
    }
  },

  async file_write(args) {
    try {
      await writeFile(args.path, args.content, 'utf-8')
      return `✅ 文件已写入：${args.path} (${args.content.length} 字符)`
    } catch (err: any) {
      return `❌ 写入文件失败：${err.message}`
    }
  },

  async file_exists(args) {
    try {
      await access(args.path, constants.F_OK)
      return `true - 文件存在：${args.path}`
    } catch {
      return `false - 文件不存在：${args.path}`
    }
  },

  // ---- Shell 工具 ----
  async shell_exec(args) {
    return new Promise((resolve) => {
      const timeout = args.timeout || 30000
      exec(args.command, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          resolve(`❌ 命令执行失败 (exit code ${error.code}):\n${stderr || error.message}`)
        } else {
          const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : '')
          resolve(output.slice(0, 8000) || '(无输出)')
        }
      })
    })
  },

  // ---- 网页工具 ----
  async web_fetch(args) {
    try {
      const response = await fetch(args.url, {
        headers: {
          'User-Agent': 'DeepSeek-Agent/0.1',
        },
      })
      const contentType = response.headers.get('content-type') || ''

      if (!response.ok) {
        return `❌ HTTP ${response.status}: ${response.statusText}`
      }

      if (contentType.includes('text/html') || contentType.includes('text/plain')) {
        const text = await response.text()
        // 简单提取文本（去除HTML标签）
        const plainText = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        const maxLen = args.maxLength || 5000
        if (plainText.length > maxLen) {
          return `网页内容 (前${maxLen}字符):\n${plainText.slice(0, maxLen)}\n\n(总长度: ${plainText.length} 字符)`
        }
        return `网页内容:\n${plainText}`
      } else if (contentType.includes('application/json')) {
        const json = await response.json()
        return JSON.stringify(json, null, 2).slice(0, 5000)
      } else {
        return `无法解析的内容类型: ${contentType}，状态码: ${response.status}`
      }
    } catch (err: any) {
      return `❌ 获取网页失败：${err.message}`
    }
  },

  async web_search(args) {
    // 使用 Bing RSS 搜索（免费、稳定、结构化 XML）
    try {
      const query = encodeURIComponent(args.query)
      const url = `https://www.bing.com/search?format=rss&q=${query}&count=${args.count || 10}`

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; DeepSeek-Agent/0.1)',
          'Accept': 'application/rss+xml, application/xml, text/xml',
        },
      })

      if (!response.ok) {
        return `❌ 搜索失败：HTTP ${response.status}`
      }

      const xml = await response.text()

      // 解析 RSS XML
      const itemRegex = /<item>([\s\S]*?)<\/item>/g
      const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/
      const linkRegex = /<link>(.*?)<\/link>/
      const descRegex = /<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/
      const dateRegex = /<pubDate>(.*?)<\/pubDate>/

      const results: Array<{ title: string; url: string; desc: string; date: string }> = []
      let match
      while ((match = itemRegex.exec(xml)) !== null && results.length < 10) {
        const item = match[1]
        const titleM = item.match(titleRegex)
        const linkM = item.match(linkRegex)
        const descM = item.match(descRegex)
        const dateM = item.match(dateRegex)

        const title = titleM ? (titleM[1] || titleM[2] || '').trim() : ''
        const url = linkM ? linkM[1].trim() : ''
        const desc = descM ? (descM[1] || descM[2] || '').trim().replace(/<[^>]*>/g, '') : ''
        const date = dateM ? dateM[1].trim() : ''

        if (title && url) {
          results.push({ title, url, desc: desc.slice(0, 300), date })
        }
      }

      if (results.length === 0) {
        return `未找到关于 "${args.query}" 的搜索结果。`
      }

      return results
        .map((r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}${r.date ? `\n   📅 ${r.date}` : ''}${r.desc ? `\n   ${r.desc}` : ''}`
        )
        .join('\n\n')
    } catch (err: any) {
      return `❌ 搜索失败：${err.message}`
    }
  },
}

// ============================
// 工具定义（OpenAI Function Calling Schema）
// ============================

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'memory_store',
    description: '存储一条长期记忆。当你学到关于用户的重要信息时使用。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '记忆标识，如"用户名"、"偏好语言"' },
        content: { type: 'string', description: '记忆内容' },
        category: {
          type: 'string',
          enum: ['general', 'preference', 'fact', 'rule'],
          description: '记忆分类',
        },
        importance: { type: 'number', description: '重要性 1-5', minimum: 1, maximum: 5 },
      },
      required: ['key', 'content'],
    },
  },
  {
    name: 'memory_recall',
    description: '搜索已存储的记忆。在需要回忆用户信息时使用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'number', description: '返回结果数量，默认5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_list',
    description: '列出所有已存储的记忆。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'file_read',
    description: '读取本地文件内容。支持文本文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        maxLength: { type: 'number', description: '最大读取字符数，默认10000' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description: '写入内容到本地文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        content: { type: 'string', description: '要写入的内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_exists',
    description: '检查文件是否存在。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'shell_exec',
    description: '执行Shell命令并获取输出。仅支持只读/非破坏性命令。输出限制8000字符。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的Shell命令' },
        timeout: { type: 'number', description: '超时毫秒数，默认30000' },
      },
      required: ['command'],
    },
  },
  {
    name: 'web_fetch',
    description: '获取网页内容。返回网页的文本内容。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '网页完整URL（含https://）' },
        maxLength: { type: 'number', description: '最大返回字符数，默认5000' },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_search',
    description: '搜索互联网获取最新信息。使用Bing搜索引擎。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'number', description: '返回结果数量，默认10' },
      },
      required: ['query'],
    },
  },
]

// ============================
// 工具执行入口
// ============================

export async function executeToolCalls(
  toolCalls: ToolCall[]
): Promise<ToolResult[]> {
  const results: ToolResult[] = []

  for (const tc of toolCalls) {
    const executor = toolExecutors[tc.function.name]
    if (!executor) {
      results.push({
        tool_call_id: tc.id,
        role: 'tool',
        content: `❌ 未知工具：${tc.function.name}`,
      })
      continue
    }

    let args: Record<string, any> = {}
    try {
      args = JSON.parse(tc.function.arguments)
    } catch {
      results.push({
        tool_call_id: tc.id,
        role: 'tool',
        content: `❌ 无法解析工具参数：${tc.function.arguments}`,
      })
      continue
    }

    try {
      const result = await executor(args)
      results.push({
        tool_call_id: tc.id,
        role: 'tool',
        content: result.slice(0, 16000), // 限制结果长度
      })
    } catch (err: any) {
      results.push({
        tool_call_id: tc.id,
        role: 'tool',
        content: `❌ 工具执行异常：${err.message}`,
      })
    }
  }

  return results
}
