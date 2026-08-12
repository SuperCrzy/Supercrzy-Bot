/**
 * Skills API 路由
 * 技能系统 CRUD + 文件化安装
 */
import Router from 'koa-router'
import { randomUUID } from 'crypto'
import { getDB } from '../services/database.js'
import { syncFileSkills, installSkillFromGitHub } from '../services/skill-loader.js'

const router = new Router({ prefix: '/api/skills' })

// 获取所有技能
router.get('/', (ctx) => {
  const db = getDB()
  const category = ctx.query.category as string

  let query = 'SELECT * FROM skills ORDER BY sort_order ASC, created_at DESC'
  const params: any[] = []

  if (category) {
    query = 'SELECT * FROM skills WHERE category = ? ORDER BY sort_order ASC, created_at DESC'
    params.push(category)
  }

  const skills = db.prepare(query).all(...params)
  ctx.body = skills
})

// 获取单个技能
router.get('/:id', (ctx) => {
  const db = getDB()
  const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(ctx.params.id)
  if (!skill) {
    ctx.status = 404
    ctx.body = { error: 'Skill not found' }
    return
  }
  ctx.body = skill
})

// 创建技能
router.post('/', (ctx) => {
  const db = getDB()
  const body = ctx.request.body as any

  const id = body.id || randomUUID()
  const skill = {
    id,
    name: body.name || 'Untitled Skill',
    description: body.description || '',
    icon: body.icon || 'star',
    category: body.category || 'general',
    enabled: body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1,
    trigger_keywords: body.trigger_keywords || '',
    prompt_template: body.prompt_template || '',
    tools: typeof body.tools === 'string' ? body.tools : JSON.stringify(body.tools || []),
    sort_order: body.sort_order || 0,
    is_builtin: body.is_builtin ? 1 : 0,
    updated_at: new Date().toISOString(),
  }

  db.prepare(`
    INSERT OR REPLACE INTO skills (id, name, description, icon, category, enabled, trigger_keywords, prompt_template, tools, sort_order, is_builtin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    skill.id, skill.name, skill.description, skill.icon, skill.category,
    skill.enabled, skill.trigger_keywords, skill.prompt_template, skill.tools,
    skill.sort_order, skill.is_builtin, skill.updated_at
  )

  ctx.body = { success: true, id }
})

// 更新技能
router.put('/:id', (ctx) => {
  const db = getDB()
  const body = ctx.request.body as any
  const id = ctx.params.id

  const existing = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as any
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Skill not found' }
    return
  }

  const fields: string[] = []
  const values: any[] = []

  const allowedFields = ['name', 'description', 'icon', 'category', 'trigger_keywords', 'prompt_template', 'sort_order']
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      fields.push(`${field} = ?`)
      values.push(body[field])
    }
  }

  if (body.enabled !== undefined) {
    fields.push('enabled = ?')
    values.push(body.enabled ? 1 : 0)
  }

  if (body.tools !== undefined) {
    fields.push('tools = ?')
    values.push(typeof body.tools === 'string' ? body.tools : JSON.stringify(body.tools))
  }

  if (fields.length === 0) {
    ctx.body = { success: true }
    return
  }

  fields.push("updated_at = datetime('now')")
  values.push(id)

  db.prepare(`UPDATE skills SET ${fields.join(', ')} WHERE id = ?`).run(...values)

  ctx.body = { success: true }
})

// 删除技能
router.delete('/:id', (ctx) => {
  const db = getDB()
  const result = db.prepare('DELETE FROM skills WHERE id = ?').run(ctx.params.id)
  if (result.changes === 0) {
    ctx.status = 404
    ctx.body = { error: 'Skill not found' }
    return
  }
  ctx.body = { success: true }
})

// 搜索匹配技能（Agent 自动匹配用）
router.post('/match', (ctx) => {
  const db = getDB()
  const { query } = ctx.request.body as { query: string }

  if (!query) {
    ctx.body = []
    return
  }

  const allSkills = db.prepare("SELECT * FROM skills WHERE enabled = 1").all() as any[]

  const matched = allSkills.filter((skill: any) => {
    if (!skill.trigger_keywords) return false
    const keywords = skill.trigger_keywords.split(',').map((k: string) => k.trim().toLowerCase())
    const queryLower = query.toLowerCase()
    return keywords.some((kw: string) => queryLower.includes(kw) || kw.includes(queryLower))
  })

  ctx.body = matched
})

// Install skill from GitHub URL
router.post('/install', async (ctx) => {
  const { url, workspaceDir } = ctx.request.body as { url: string; workspaceDir?: string }
  if (!url) {
    ctx.status = 400
    ctx.body = { success: false, error: 'GitHub URL is required' }
    return
  }

  try {
    const result = await installSkillFromGitHub(url, workspaceDir || process.cwd())
    if (result.success) {
      ctx.body = { success: true, name: result.name }
    } else {
      ctx.status = 400
      ctx.body = { success: false, error: result.error }
    }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err.message }
  }
})

// Sync file-based skills
router.post('/sync', (ctx) => {
  try {
    const workspaceDir = (ctx.request.body as any).workspaceDir || process.cwd()
    // Auto-seed builtin skills if DB is empty
    const db = getDB()
    const count = (db.prepare('SELECT COUNT(*) as c FROM skills').get() as any).c
    if (count === 0) {
      seedBuiltinSkills()
    }
    const result = syncFileSkills(workspaceDir)
    ctx.body = { success: true, ...result }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err.message }
  }
})

// 初始化内置技能
export function seedBuiltinSkills() {
  const db = getDB()

  const count = (db.prepare('SELECT COUNT(*) as c FROM skills').get() as any).c
  if (count > 0) return

  const builtinSkills = [
    {
      name: '代码生成',
      icon: 'code',
      description: '根据自然语言描述生成代码，支持多种编程语言',
      category: 'coding',
      enabled: true,
      trigger_keywords: '代码,code,编程,program,函数,function,实现,implement',
      prompt_template: 'You are a coding expert. Generate clean, well-commented code based on the user\'s requirements. Always explain your approach first, then provide the code.',
      tools: JSON.stringify(['file_write', 'shell_exec']),
      sort_order: 1,
      is_builtin: 1,
    },
    {
      name: '文件操作',
      icon: 'folder',
      description: '读写本地文件系统，管理项目文件结构',
      category: 'coding',
      enabled: true,
      trigger_keywords: '文件,file,读取,read,写入,write,目录,directory',
      prompt_template: 'You are a file system expert. Help the user manage files - read, write, organize. Always confirm before destructive operations.',
      tools: JSON.stringify(['file_read', 'file_write', 'file_exists', 'shell_exec']),
      sort_order: 2,
      is_builtin: 1,
    },
    {
      name: '网络搜索',
      icon: 'globe',
      description: '搜索互联网获取最新信息和资料',
      category: 'research',
      enabled: true,
      trigger_keywords: '搜索,search,查找,find,最新,latest,新闻,news',
      prompt_template: 'You are a research assistant. Search the web to find relevant, up-to-date information. Always cite your sources and verify accuracy.',
      tools: JSON.stringify(['web_search', 'web_fetch']),
      sort_order: 3,
      is_builtin: 1,
    },
    {
      name: 'Shell 执行',
      icon: 'zap',
      description: '执行 Shell 命令完成系统操作任务',
      category: 'system',
      enabled: false,
      trigger_keywords: '命令,command,终端,terminal,运行,run,执行,execute,安装,install',
      prompt_template: 'You are a system administrator expert. Execute commands safely. Always explain what each command does before running it. Warn about potentially dangerous operations.',
      tools: JSON.stringify(['shell_exec', 'file_read', 'file_exists']),
      sort_order: 4,
      is_builtin: 1,
    },
    {
      name: '浏览器自动化',
      icon: 'monitor',
      description: '控制浏览器进行网页交互和数据采集',
      category: 'automation',
      enabled: false,
      trigger_keywords: '浏览器,browser,网页,website,抓取,scrape,自动化,automation',
      prompt_template: 'You are a browser automation expert. Help with web scraping, form filling, and browser-based tasks. Use web_fetch for simple requests.',
      tools: JSON.stringify(['web_fetch', 'web_search', 'shell_exec']),
      sort_order: 5,
      is_builtin: 1,
    },
    {
      name: '数据可视化',
      icon: 'activity',
      description: '将数据转换为图表和可视化报告',
      category: 'analysis',
      enabled: true,
      trigger_keywords: '图表,chart,可视化,visualize,数据,data,分析,analyze',
      prompt_template: 'You are a data visualization expert. Help create charts, graphs, and visual representations of data. Recommend the best chart type for the data.',
      tools: JSON.stringify(['file_read', 'file_write', 'shell_exec']),
      sort_order: 6,
      is_builtin: 1,
    },
    {
      name: '文档写作',
      icon: 'pen',
      description: '撰写技术文档、README、API 文档等',
      category: 'writing',
      enabled: true,
      trigger_keywords: '文档,document,README,撰写,write,说明,manual',
      prompt_template: 'You are a technical writer. Create clear, well-structured documentation. Follow best practices for technical writing.',
      tools: JSON.stringify(['file_read', 'file_write', 'web_search']),
      sort_order: 7,
      is_builtin: 1,
    },
    {
      name: '记忆管理',
      icon: 'brain',
      description: '管理和查询 Agent 的长期记忆',
      category: 'system',
      enabled: true,
      trigger_keywords: '记忆,memory,记住,remember,回忆,recall',
      prompt_template: 'You are a memory management assistant. Help store, recall, and organize information in long-term memory.',
      tools: JSON.stringify(['memory_store', 'memory_recall', 'memory_list']),
      sort_order: 8,
      is_builtin: 1,
    },
  ]

  const stmt = db.prepare(`
    INSERT INTO skills (id, name, description, icon, category, enabled, trigger_keywords, prompt_template, tools, sort_order, is_builtin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `)

  for (const skill of builtinSkills) {
    stmt.run(
      randomUUID(), skill.name, skill.description, skill.icon,
      skill.category, skill.enabled ? 1 : 0, skill.trigger_keywords,
      skill.prompt_template, skill.tools, skill.sort_order
    )
  }

  console.log(`[skills] Seeded ${builtinSkills.length} builtin skills`)
}

export default router
