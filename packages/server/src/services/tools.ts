/**
 * Agent 工具定义与执行器
 * 每个工具包含 OpenAI Function Calling 格式的 schema 和执行函数
 */
import { getDB } from './database'
import { randomUUID } from 'crypto'
import { readFile, writeFile, access } from 'fs/promises'
import { exec } from 'child_process'
import { constants } from 'fs'
import { installSkillFromGitHub, initSkillsDirectory } from './skill-loader'
import { join } from 'path'

// ============================
// 类型定义
// ============================

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, any>
  category?: 'memory' | 'file' | 'network' | 'system' | 'interaction'
  dangerous?: boolean
}

export interface ToolMeta {
  name: string
  category: 'memory' | 'file' | 'network' | 'system' | 'interaction'
  dangerous: boolean
  duration?: number
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
    if (rows.length === 0) return 'No memories stored.'
    return rows.map((r: any) => `[${r.key}] (${r.category}, importance:${r.importance}) ${r.content}`).join('\n')
  },

  // ---- 任务工具 ----
  async task_create(args) {
    const db = getDB()
    const id = randomUUID()
    db.prepare(
      'INSERT INTO tasks (id, session_id, subject, description, status) VALUES (?, ?, ?, ?, ?)'
    ).run(id, args.session_id || null, args.subject, args.description || '', 'pending')

    // Auto-create sub-tasks if provided
    if (Array.isArray(args.subtasks)) {
      for (let i = 0; i < args.subtasks.length; i++) {
        const sub = args.subtasks[i]
        db.prepare(
          'INSERT INTO tasks (id, session_id, parent_id, subject, description, status, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(randomUUID(), args.session_id || null, id, sub.subject || sub, sub.description || '', 'pending', i)
      }
    }

    return `Task created: [${id}] "${args.subject}" ${args.subtasks ? `with ${args.subtasks.length} sub-tasks` : ''}`
  },

  async task_update(args) {
    const db = getDB()
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(args.id) as any
    if (!task) return `Task not found: ${args.id}`

    const updates: string[] = []
    if (args.status) { db.prepare('UPDATE tasks SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(args.status, args.id); updates.push(`status → ${args.status}`) }
    if (args.progress !== undefined) { db.prepare('UPDATE tasks SET progress = ?, updated_at = datetime(\'now\') WHERE id = ?').run(args.progress, args.id); updates.push(`progress → ${args.progress}%`) }
    if (args.subject) { db.prepare('UPDATE tasks SET subject = ?, updated_at = datetime(\'now\') WHERE id = ?').run(args.subject, args.id); updates.push(`subject updated`) }

    return updates.length > 0 ? `Task updated: ${updates.join(', ')}` : 'No changes made. Use status/pending, status/in_progress, status/completed, progress/0-100.'
  },

  async task_list(args) {
    const db = getDB()
    let query = 'SELECT * FROM tasks WHERE 1=1'
    const params: any[] = []
    if (args.session_id) { query += ' AND session_id = ?'; params.push(args.session_id) }
    if (args.status) { query += ' AND status = ?'; params.push(args.status) }
    query += ' ORDER BY sort_order ASC LIMIT 20'

    const tasks = db.prepare(query).all(...params) as any[]
    if (tasks.length === 0) return args.status ? `No ${args.status} tasks` : 'No tasks found.'

    return tasks.map((t: any) =>
      `${t.status === 'in_progress' ? '▶' : t.status === 'completed' ? '✓' : '○'} [${t.status}] ${t.subject}${t.progress ? ` (${t.progress}%)` : ''}`
    ).join('\n')
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
          'User-Agent': 'SuperCrzy/1.0',
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
          'User-Agent': 'Mozilla/5.0 (compatible; SuperCrzy/1.0)',
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
        return JSON.stringify({ results: [], query: args.query, message: `未找到关于 "${args.query}" 的搜索结果。` })
      }

      return JSON.stringify({
        results: results.map(r => ({ title: r.title, url: r.url, description: r.desc, date: r.date })),
        query: args.query,
      })
    } catch (err: any) {
      return `❌ 搜索失败：${err.message}`
    }
  },

  // ---- 技能管理工具 ----
  async skill_list(_args) {
    const db = getDB()
    const rows = db.prepare(
      'SELECT name, description, category, enabled, is_builtin, trigger_keywords FROM skills ORDER BY sort_order ASC, created_at DESC'
    ).all() as any[]
    if (rows.length === 0) return 'No skills installed.'
    return rows.map((r: any) => {
      const status = r.enabled ? 'ON' : 'OFF'
      const source = r.is_builtin ? 'builtin' : 'installed'
      return `[${status}] ${r.name} (${r.category}, ${source}) - ${r.description}`
    }).join('\n')
  },

  async skill_search(args) {
    const query = args.query || args.q || ''
    if (!query.trim()) return 'Usage: skill_search(query="docker deploy")'

    const searchQuery = `${query} SKILL.md agent skill github`
    try {
      const encoded = encodeURIComponent(searchQuery)
      const url = `https://www.bing.com/search?format=rss&q=${encoded}&count=8`
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SuperCrzy/1.0)', 'Accept': 'application/rss+xml' },
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

  async skill_view(args) {
    const db = getDB()
    const name = args.name || args.id || ''
    if (!name) return 'Usage: skill_view(name="skill-name") or skill_view(id="uuid")'

    const skill = name.length > 20
      ? db.prepare('SELECT * FROM skills WHERE id = ?').get(name) as any
      : db.prepare('SELECT * FROM skills WHERE name LIKE ?').get(`%${name}%`) as any

    if (!skill) return `Skill not found: ${name}. Use skill_list() to see available skills.`

    let tools = ''
    try { tools = JSON.parse(skill.tools || '[]').join(', ') || 'none' } catch { tools = skill.tools || 'none' }

    return [
      `=== ${skill.name} ===`,
      `Description: ${skill.description}`,
      `Category: ${skill.category}`,
      `Status: ${skill.enabled ? 'Active' : 'Disabled'}`,
      `Source: ${skill.is_builtin ? 'builtin' : 'installed'}`,
      `Keywords: ${skill.trigger_keywords || 'none'}`,
      `Tools: ${tools}`,
      skill.source_file ? `File: ${skill.source_file}` : '',
      skill.prompt_template ? `\n--- Prompt Template ---\n${skill.prompt_template}` : '',
    ].filter(Boolean).join('\n')
  },

  async skill_install(args) {
    const url = args.url || args.github || ''
    if (!url.trim()) return 'Usage: skill_install(url="https://github.com/user/skill-repo")'

    try {
      initSkillsDirectory(process.cwd())
      const result = await installSkillFromGitHub(url.trim(), process.cwd())
      if (result.success) {
        return `Installed skill: ${result.name}\nSkill is now active. Use skill_view(name="${result.name}") to see details.`
      } else {
        return `Install failed: ${result.error}`
      }
    } catch (err: any) {
      return `Skill install error: ${err.message}`
    }
  },

  // ---- 交互工具 ----
  async ask_user(args) {
    // 返回标记供 agent loop 拦截，不立即执行
    return `__ASK_USER__${JSON.stringify({
      question: args.question,
      header: args.header || '确认',
      options: args.options,
      multiSelect: args.multiSelect || false,
    })}`
  },
}

// ============================
// 工具定义（OpenAI Function Calling Schema）
// ============================

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'memory_store',
    description: '存储一条长期记忆。当你学到关于用户的重要信息时使用。',
    category: 'memory',
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
    category: 'memory',
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
    category: 'memory',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'file_read',
    description: '读取本地文件内容。支持文本文件。',
    category: 'file',
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
    category: 'file',
    dangerous: true,
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
    category: 'file',
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
    category: 'system',
    dangerous: true,
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
    category: 'network',
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
    name: 'task_create',
    description: 'Create a new task with optional sub-tasks. Use for planning and tracking work.',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        session_id: { type: 'string', description: 'Associated session ID' },
        subtasks: { type: 'array', items: { type: 'object', properties: { subject: { type: 'string' }, description: { type: 'string' } } }, description: 'Sub-tasks' },
      },
      required: ['subject'],
    },
  },
  {
    name: 'task_update',
    description: 'Update task status, progress, or subject. Status: pending/in_progress/completed.',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task ID' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'New status' },
        progress: { type: 'number', description: 'Progress 0-100' },
        subject: { type: 'string', description: 'New subject' },
      },
      required: ['id'],
    },
  },
  {
    name: 'task_list',
    description: 'List tasks, optionally filtered by session or status.',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Filter by session' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Filter by status' },
      },
    },
  },
  {
    name: 'skill_list',
    description: '列出所有已安装的技能模块。查看 agent 当前具备哪些能力。',
    category: 'system',
    parameters: { type: 'object', properties: {} },
  },
  {
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
  },
  {
    name: 'skill_view',
    description: '查看指定技能的完整详情，包括 prompt template 和可用工具。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名称（模糊匹配）' },
        id: { type: 'string', description: '技能 UUID' },
      },
    },
  },
  {
    name: 'skill_install',
    description: '从 GitHub 安装第三方技能。传入包含 SKILL.md 的 GitHub 仓库 URL。',
    category: 'system',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'GitHub 仓库 URL，如 https://github.com/user/skill-repo' },
      },
      required: ['url'],
    },
  },
  {
    name: 'ask_user',
    description: '当你遇到歧义或需要用户决策时使用。提出问题并列出选项，等待用户选择后继续执行。仅在确实需要用户输入时才调用。',
    category: 'interaction',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '向用户提出的问题' },
        header: { type: 'string', description: '问题简短标题（最多12字）' },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '选项显示文字' },
              description: { type: 'string', description: '选项说明' },
            },
            required: ['label', 'description'],
          },
          description: '选项列表（2-4个）',
        },
        multiSelect: { type: 'boolean', description: '是否允许多选', default: false },
      },
      required: ['question', 'options'],
    },
  },
]

// ============================
// 工具元数据查询
// ============================

export function getToolMeta(name: string): ToolMeta | undefined {
  const def = toolDefinitions.find(t => t.name === name)
  if (!def) return undefined
  return {
    name: def.name,
    category: def.category || 'system',
    dangerous: def.dangerous || false,
  }
}

export function getToolsByCategory(category: string): ToolDefinition[] {
  return toolDefinitions.filter(t => t.category === category)
}

// ============================
// 工具执行入口
// ============================

export interface ToolResultWithMeta extends ToolResult {
  duration?: number
}

export async function executeToolCalls(
  toolCalls: ToolCall[]
): Promise<ToolResultWithMeta[]> {
  const results: ToolResultWithMeta[] = []

  for (const tc of toolCalls) {
    const executor = toolExecutors[tc.function.name]
    if (!executor) {
      results.push({
        tool_call_id: tc.id,
        role: 'tool',
        content: `Unknown tool: ${tc.function.name}`,
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
        content: `Failed to parse tool arguments: ${tc.function.arguments}`,
      })
      continue
    }

    try {
      const startTime = Date.now()
      const result = await executor(args)
      const duration = (Date.now() - startTime) / 1000
      results.push({
        tool_call_id: tc.id,
        role: 'tool',
        content: result.slice(0, 16000),
        duration,
      })
    } catch (err: any) {
      results.push({
        tool_call_id: tc.id,
        role: 'tool',
        content: `Tool execution error: ${err.message}`,
      })
    }
  }

  return results
}
