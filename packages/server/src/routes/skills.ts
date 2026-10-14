/**
 * Skills API 路由
 * 技能系统 CRUD + 文件化安装
 */
import Router from 'koa-router'
import { randomUUID } from 'crypto'
import { getDB } from '../services/database.js'
import { syncFileSkills, installSkillFromGitHub, exportSkillToFile, exportAllSkillsToFiles, scanSkillRepo } from '../services/skill-loader.js'

const router = new Router({ prefix: '/api/skills' })

/** 搜索 GitHub 第三方技能（复用 agent skill_search 逻辑：Bing RSS 搜 SKILL.md 技能仓库） */
export async function searchGitHubSkills(query: string, count = 8): Promise<Array<{ title: string; url: string }>> {
  const searchQuery = `${query} SKILL.md agent skill github`
  const encoded = encodeURIComponent(searchQuery)
  const url = `https://www.bing.com/search?format=rss&q=${encoded}&count=${count}`
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUPERCRZY-BOT/1.0)', 'Accept': 'application/rss+xml' },
  })
  if (!response.ok) throw new Error(`Search failed: HTTP ${response.status}`)
  const xml = await response.text()
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  const titleRegex = /<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/
  const linkRegex = /<link>(.*?)<\/link>/
  const results: Array<{ title: string; url: string }> = []
  let match
  while ((match = itemRegex.exec(xml)) !== null && results.length < count) {
    const item = match[1]
    const titleM = item.match(titleRegex)
    const linkM = item.match(linkRegex)
    const title = titleM ? (titleM[1] || titleM[2] || '').trim() : ''
    const repoUrl = linkM ? linkM[1].trim() : ''
    if (title && repoUrl && /^https?:\/\//.test(repoUrl)) {
      results.push({ title, url: repoUrl })
    }
  }
  return results
}

// 内置技能市场目录（静态清单：市场展示全部，installed 状态由前端/接口按 DB 判断；
// 卸载后从市场可重新安装。新增内置技能在此追加即可，老用户通过 /catalog 看到"未安装"后手动装）
export const BUILTIN_CATALOG: Array<{
  name: string; icon: string; description: string; category: string
  enabled: boolean; trigger_keywords: string; prompt_template: string
  tools: string[]; globs: string[]; environments: string; sort_order: number; core: boolean
}> = [
  { name: '代码生成', icon: 'code', description: '根据自然语言描述生成代码，支持多种编程语言', category: 'coding', enabled: true, trigger_keywords: '代码,code,编程,program,函数,function,实现,implement', globs: ['*.js','*.ts','*.py','*.go','*.rs','*.java','*.vue'], environments: 'node,all', prompt_template: 'You are a coding expert. Generate clean, well-commented code based on the user\'s requirements. Always explain your approach first, then provide the code.', tools: ['file_write','shell_exec'], sort_order: 1, core: true },
  { name: '文件操作', icon: 'folder', description: '读写本地文件系统，管理项目文件结构', category: 'coding', enabled: true, trigger_keywords: '文件,file,读取,read,写入,write,目录,directory', globs: [], environments: 'all', prompt_template: 'You are a file system expert. Help the user manage files - read, write, organize. Always confirm before destructive operations.', tools: ['file_read','file_write','file_exists','shell_exec'], sort_order: 2, core: true },
  { name: '代码审查', icon: 'review', description: '审查代码质量、安全性和可维护性，给出改进建议', category: 'coding', enabled: false, trigger_keywords: '审查,review,代码质量,quality,重构,refactor,优化,optimize', globs: [], environments: 'all', prompt_template: 'You are a senior code reviewer. Review code for bugs, security issues, performance and maintainability. Provide concrete, actionable feedback with code examples.', tools: ['file_read','file_write'], sort_order: 3, core: false },
  { name: '调试诊断', icon: 'bug', description: '分析报错信息，定位并修复问题', category: 'coding', enabled: false, trigger_keywords: '调试,debug,报错,error,异常,exception,修复,fix,崩溃,crash', globs: [], environments: 'all', prompt_template: 'You are a debugging expert. Analyze error messages and stack traces, identify root causes, and propose fixes. Test hypotheses systematically.', tools: ['file_read','shell_exec','file_write'], sort_order: 4, core: false },
  { name: '网络搜索', icon: 'globe', description: '搜索互联网获取最新信息和资料', category: 'research', enabled: true, trigger_keywords: '搜索,search,查找,find,最新,latest,新闻,news', globs: [], environments: 'all', prompt_template: 'You are a research assistant. Search the web to find relevant, up-to-date information. Always cite your sources and verify accuracy.', tools: ['web_search','web_fetch'], sort_order: 5, core: true },
  { name: '网页抓取', icon: 'link', description: '抓取网页内容，提取结构化数据', category: 'research', enabled: false, trigger_keywords: '抓取,scrape,爬取,crawl,提取,extract,网页,webpage', globs: [], environments: 'all', prompt_template: 'You are a web scraping expert. Extract structured data from web pages. Respect robots.txt and rate limits. Handle dynamic content gracefully.', tools: ['web_fetch','web_search','file_write'], sort_order: 6, core: false },
  { name: '深度研究', icon: 'telescope', description: '多轮搜索交叉验证，产出深度研究报告', category: 'research', enabled: false, trigger_keywords: '深度研究,deep research,研究报告,report,专题,调研', globs: [], environments: 'all', prompt_template: 'You are a deep research analyst. Plan a multi-step research strategy, gather information from multiple sources, cross-validate facts, and produce a structured report with sources.', tools: ['web_search','web_fetch','file_write'], sort_order: 7, core: false },
  { name: 'Shell 执行', icon: 'zap', description: '执行 Shell 命令完成系统操作任务', category: 'system', enabled: true, trigger_keywords: '命令,command,终端,terminal,运行,run,执行,execute,安装,install', globs: [], environments: 'all', prompt_template: 'You are a system administrator expert. Execute commands safely. Always explain what each command does before running it. Warn about potentially dangerous operations.', tools: ['shell_exec','file_read','file_exists'], sort_order: 8, core: true },
  { name: '记忆管理', icon: 'brain', description: '管理和查询 Agent 的长期记忆', category: 'system', enabled: true, trigger_keywords: '记忆,memory,记住,remember,回忆,recall', globs: [], environments: 'all', prompt_template: 'You are a memory management assistant. Help store, recall, and organize information in long-term memory.', tools: ['memory_store','memory_recall','memory_list'], sort_order: 9, core: false },
  { name: '浏览器自动化', icon: 'monitor', description: '控制浏览器进行网页交互和数据采集', category: 'automation', enabled: false, trigger_keywords: '浏览器,browser,网页,website,抓取,scrape,自动化,automation', globs: [], environments: 'all', prompt_template: 'You are a browser automation expert. Help with web scraping, form filling, and browser-based tasks. Use web_fetch for simple requests.', tools: ['web_fetch','web_search','shell_exec'], sort_order: 10, core: false },
  { name: '定时任务', icon: 'clock', description: '创建和管理定时自动执行的任务', category: 'automation', enabled: false, trigger_keywords: '定时,schedule,cron,每天,daily,每周,weekly,自动,auto', globs: [], environments: 'all', prompt_template: 'You are an automation expert. Help users set up scheduled tasks and recurring automations. Explain schedules clearly and verify triggers.', tools: ['shell_exec'], sort_order: 11, core: false },
  { name: '数据可视化', icon: 'activity', description: '将数据转换为图表和可视化报告', category: 'analysis', enabled: true, trigger_keywords: '图表,chart,可视化,visualize,数据,data,分析,analyze', globs: [], environments: 'all', prompt_template: 'You are a data visualization expert. Help create charts, graphs, and visual representations of data. Recommend the best chart type for the data.', tools: ['file_read','file_write','shell_exec'], sort_order: 12, core: true },
  { name: '数据分析', icon: 'chart', description: '统计分析数据，发现趋势与洞察', category: 'analysis', enabled: true, trigger_keywords: '数据分析,data analysis,统计,statistics,趋势,trend,洞察,insight,报表', globs: [], environments: 'all', prompt_template: 'You are a data analyst. Clean, explore and analyze data. Use statistics and visualizations to surface trends and insights. Present findings clearly.', tools: ['file_read','file_write','shell_exec'], sort_order: 13, core: false },
  { name: '文档写作', icon: 'pen', description: '撰写技术文档、README、API 文档等', category: 'writing', enabled: true, trigger_keywords: '文档,document,README,撰写,write,说明,manual', globs: [], environments: 'all', prompt_template: 'You are a technical writer. Create clear, well-structured documentation. Follow best practices for technical writing.', tools: ['file_read','file_write','web_search'], sort_order: 14, core: true },
  { name: '文案写作', icon: 'megaphone', description: '撰写营销文案、广告语、宣传物料', category: 'writing', enabled: true, trigger_keywords: '文案,copy,营销,marketing,广告,ad,标语,slogan,宣传', globs: [], environments: 'all', prompt_template: 'You are a copywriting expert. Write persuasive, on-brand marketing copy. Understand the audience and call-to-action first, then craft concise impactful copy.', tools: ['file_write'], sort_order: 15, core: false },
  { name: '翻译润色', icon: 'languages', description: '多语言翻译与文本润色改写', category: 'writing', enabled: true, trigger_keywords: '翻译,translate,润色,polish,改写,rewrite,校对,proofread,英文,english', globs: [], environments: 'all', prompt_template: 'You are a professional translator and editor. Translate accurately while preserving tone, and polish text for clarity, conciseness and flow.', tools: ['file_write'], sort_order: 16, core: true },
  { name: 'PDF 处理', icon: 'file-text', description: '读取、合并、转换 PDF 文档', category: 'general', enabled: true, trigger_keywords: 'PDF,pdf,文档,文档处理,提取,提取文本', globs: ['*.pdf'], environments: 'all', prompt_template: 'You are a PDF expert. Help read, merge, split, convert and extract text from PDF documents.', tools: ['file_read','shell_exec'], sort_order: 17, core: true },
  { name: 'Git 操作', icon: 'git', description: '版本控制操作：提交、分支、合并、回滚', category: 'coding', enabled: false, trigger_keywords: 'git,提交,commit,分支,branch,合并,merge,回滚,revert,push,pull', globs: [], environments: 'all', prompt_template: 'You are a Git expert. Help with commits, branching, merging, rebasing, and history. Explain what each command does before running it.', tools: ['shell_exec'], sort_order: 18, core: false },
  { name: 'API 开发', icon: 'server', description: '设计、实现和调试 REST API', category: 'coding', enabled: false, trigger_keywords: 'API,接口,restful,后端,backend,路由,route,curl,请求,request', globs: [], environments: 'node,all', prompt_template: 'You are a backend API expert. Design clean RESTful endpoints, handle errors consistently, validate inputs, and document with examples.', tools: ['file_read','file_write','shell_exec'], sort_order: 19, core: false },
  { name: 'SQL 查询', icon: 'database', description: '编写和优化 SQL 查询与数据检索', category: 'analysis', enabled: false, trigger_keywords: 'SQL,sql,查询,query,数据库,database,表,table,索引,index,优化', globs: [], environments: 'all', prompt_template: 'You are a SQL expert. Write correct, performant queries. Explain the data model assumptions and index implications.', tools: ['file_read','shell_exec'], sort_order: 20, core: false },
  { name: '正则表达式', icon: 'regex', description: '编写和调试正则表达式匹配规则', category: 'coding', enabled: false, trigger_keywords: '正则,regex,正则表达式,匹配,match,替换,replace,pattern', globs: [], environments: 'all', prompt_template: 'You are a regex expert. Write clear regular expressions, explain each part, and provide test cases.', tools: ['file_read'], sort_order: 21, core: false },
  { name: '竞品调研', icon: 'binoculars', description: '调研竞品定位、功能与定价', category: 'research', enabled: false, trigger_keywords: '竞品,competitor,调研,research,对比,compare,市场,market,分析,analysis', globs: [], environments: 'all', prompt_template: 'You are a competitive intelligence analyst. Research competitors systematically - positioning, features, pricing, and gaps. Structure findings for decisions.', tools: ['web_search','web_fetch','file_write'], sort_order: 22, core: false },
  { name: 'SEO 分析', icon: 'trend', description: '分析网站 SEO 表现并给出优化建议', category: 'research', enabled: false, trigger_keywords: 'SEO,seo,搜索优化,排名,ranking,关键词,keyword,外链,backlink', globs: [], environments: 'all', prompt_template: 'You are an SEO specialist. Audit on-page SEO, meta tags, content structure, and performance. Give prioritized, actionable fixes.', tools: ['web_fetch','web_search','file_write'], sort_order: 23, core: false },
  { name: '报告生成', icon: 'file-text', description: '把研究结果整理为结构化报告', category: 'writing', enabled: false, trigger_keywords: '报告,report,总结,summary,白皮书,whitepaper,文档,document', globs: [], environments: 'all', prompt_template: 'You are a report writer. Turn research findings into clear, structured reports with executive summary, findings, and recommendations.', tools: ['file_write'], sort_order: 24, core: false },
  { name: '会议纪要', icon: 'clipboard', description: '整理会议记录、提取行动项与决策', category: 'writing', enabled: false, trigger_keywords: '会议,meeting,纪要,minutes,记录,notes,行动项,action item,决策,decision', globs: [], environments: 'all', prompt_template: 'You are a meeting note specialist. Structure minutes with decisions, action items (with owners), and open questions.', tools: ['file_write'], sort_order: 25, core: false },
  { name: '邮件写作', icon: 'mail', description: '撰写专业邮件与商务沟通', category: 'writing', enabled: false, trigger_keywords: '邮件,email,写信,回复,reply,商务,business,沟通,communication', globs: [], environments: 'all', prompt_template: 'You are a business communication expert. Write clear, professional emails with appropriate tone, subject lines, and call-to-action.', tools: ['file_write'], sort_order: 26, core: false },
  { name: 'Excel 处理', icon: 'table', description: '读写和分析 Excel 表格数据', category: 'analysis', enabled: false, trigger_keywords: 'Excel,excel,xlsx,表格,spreadsheet,sheet,单元格,cell,公式,formula', globs: ['*.xlsx','*.xls','*.csv'], environments: 'python,all', prompt_template: 'You are a spreadsheet expert. Read, analyze and generate Excel data. Handle formulas, formatting and large datasets efficiently.', tools: ['file_read','file_write','shell_exec'], sort_order: 27, core: false },
  { name: '数据清洗', icon: 'filter', description: '清洗脏数据：去重、补缺、格式化', category: 'analysis', enabled: false, trigger_keywords: '清洗,clean,去重,dedupe,缺失,missing,格式化,format,脏数据', globs: [], environments: 'all', prompt_template: 'You are a data cleaning expert. Detect and fix duplicates, missing values, inconsistent formats, and outliers. Document every transformation.', tools: ['file_read','file_write','shell_exec'], sort_order: 28, core: false },
  { name: '系统监控', icon: 'gauge', description: '检查系统资源占用与运行状态', category: 'system', enabled: false, trigger_keywords: '监控,monitor,CPU,内存,memory,磁盘,disk,进程,process,状态,status,性能,performance', globs: [], environments: 'all', prompt_template: 'You are a system monitoring expert. Check CPU, memory, disk, and process health. Diagnose bottlenecks and suggest improvements.', tools: ['shell_exec','file_read'], sort_order: 29, core: false },
  { name: '网络诊断', icon: 'wifi', description: '诊断网络连接、DNS 与连通性问题', category: 'system', enabled: false, trigger_keywords: '网络,network,DNS,连通性,connectivity,ping,延迟,latency,端口,port', globs: [], environments: 'all', prompt_template: 'You are a network diagnostics expert. Trace connectivity issues systematically - DNS, routing, ports, and local config.', tools: ['shell_exec'], sort_order: 30, core: false },
  { name: '批量重命名', icon: 'repeat', description: '按规则批量重命名文件', category: 'automation', enabled: false, trigger_keywords: '重命名,rename,批量,batch,文件,file,改名', globs: [], environments: 'all', prompt_template: 'You are a file management expert. Rename files in batches with clear rules. Always preview the rename plan and confirm before applying.', tools: ['shell_exec','file_read'], sort_order: 31, core: false },
  { name: '图片处理', icon: 'image', description: '压缩、转换、裁剪图片', category: 'general', enabled: false, trigger_keywords: '图片,image,压缩,compress,转换,convert,裁剪,crop,resize,格式,format', globs: ['*.png','*.jpg','*.jpeg','*.webp'], environments: 'all', prompt_template: 'You are an image processing expert. Compress, convert and resize images while preserving quality. Explain trade-offs.', tools: ['shell_exec','file_read'], sort_order: 32, core: false },
]

// 内置市场清单 + 安装状态（必须在 /:id 之前注册，避免 'catalog' 被当 id）
// 返回完整字段（含 prompt_template/tools/globs 等），前端安装内置时直接透传创建
router.get('/catalog', (ctx) => {
  const db = getDB()
  const installed = db.prepare('SELECT id, name, enabled FROM skills').all() as Array<{ id: string; name: string; enabled: number }>
  const byName = new Map(installed.map((s) => [s.name, s]))
  ctx.body = BUILTIN_CATALOG.map((skill) => {
    const inst = byName.get(skill.name)
    return {
      ...skill,
      installed: !!inst,
      enabled: inst ? !!inst.enabled : skill.enabled,
      id: inst ? inst.id : null,
    }
  })
})

// ===== 开源技能源（对齐 Hermes Skills Hub：browse.sh + GitHub 官方技能仓库） =====

// browse.sh 源：461 个站点浏览器自动化技能（Browserbase），代理 + 内存缓存 5 分钟
let browseCache: { at: number; data: any } | null = null
router.get('/sources/browse', async (ctx) => {
  try {
    if (!browseCache || Date.now() - browseCache.at > 5 * 60 * 1000) {
      const res = await fetch('https://browse.sh/api/skills', {
        headers: { 'User-Agent': 'SUPERCRZY-BOT/1.0' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) throw new Error(`browse.sh HTTP ${res.status}`)
      browseCache = { at: Date.now(), data: await res.json() }
    }
    const all: any[] = browseCache.data.skills || []
    const q = ((ctx.query.q as string) || '').toLowerCase().trim()
    const category = (ctx.query.category as string) || ''
    const limit = Math.min(parseInt(ctx.query.limit as string, 10) || 100, 200)
    let list = all
    if (q) list = list.filter((s) => `${s.title} ${s.description} ${(s.tags || []).join(' ')}`.toLowerCase().includes(q))
    if (category) list = list.filter((s) => s.category === category)
    ctx.body = list.slice(0, limit).map((s) => ({
      name: s.name, title: s.title, description: s.description, category: s.category,
      slug: s.slug, sourceUrl: s.sourceUrl, installCount: s.installCount || 0, verified: !!s.verified,
    }))
  } catch (e: any) {
    ctx.status = 502
    ctx.body = { error: e.message }
  }
})

// browse.sh 分类列表（供前端分类筛选）
router.get('/sources/browse/categories', async (ctx) => {
  try {
    if (!browseCache || Date.now() - browseCache.at > 5 * 60 * 1000) {
      const res = await fetch('https://browse.sh/api/skills', {
        headers: { 'User-Agent': 'SUPERCRZY-BOT/1.0' },
        signal: AbortSignal.timeout(15000),
      })
      browseCache = { at: Date.now(), data: await res.json() }
    }
    const all: any[] = browseCache.data.skills || []
    const cats = Array.from(new Set(all.map((s) => s.category).filter(Boolean))).sort()
    ctx.body = cats
  } catch (e: any) {
    ctx.status = 502
    ctx.body = { error: e.message }
  }
})

// GitHub 官方技能仓库白名单（Hermes 默认 trusted taps）
const OFFICIAL_SKILL_REPOS = ['openai/skills', 'anthropics/skills', 'huggingface/skills', 'NVIDIA/skills']
let ghReposCache: Record<string, { at: number; data: any }> = {}
router.get('/sources/github', async (ctx) => {
  const repo = (ctx.query.repo as string) || 'anthropics/skills'
  if (!OFFICIAL_SKILL_REPOS.includes(repo)) {
    ctx.status = 400
    ctx.body = { error: 'unsupported repo' }
    return
  }
  try {
    const cached = ghReposCache[repo]
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) { ctx.body = cached.data; return }
    const [owner, name] = repo.split('/')
    const listDir = async (path: string): Promise<any[] | null> => {
      const r = await fetch(`https://api.github.com/repos/${owner}/${name}/contents/${path}`, {
        headers: { 'User-Agent': 'SUPERCRZY-BOT/1.0' },
        signal: AbortSignal.timeout(10000),
      })
      if (!r.ok) return null
      return r.json()
    }
    let items = await listDir('skills')
    let base = 'skills'
    if (!Array.isArray(items)) { items = await listDir(''); base = '' }
    if (!Array.isArray(items)) { ctx.body = []; return }
    const dirs = items.filter((x: any) => x.type === 'dir' && !x.name.startsWith('.')).slice(0, 40)

    // 读每个技能的 SKILL.md frontmatter 描述（raw.githubusercontent 不受 API 限流；8 并发分块）
    const readDesc = async (dirName: string): Promise<string> => {
      try {
        const r = await fetch(
          `https://raw.githubusercontent.com/${owner}/${name}/main/${base ? base + '/' : ''}${dirName}/SKILL.md`,
          { headers: { 'User-Agent': 'SUPERCRZY-BOT/1.0', Range: 'bytes=0-3000' }, signal: AbortSignal.timeout(8000) },
        )
        if (!r.ok) return ''
        const text = await r.text()
        const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (!fm) return ''
        const descMatch = fm[1].match(/^description:\s*(.+)$/m)
        if (!descMatch) return ''
        let line = descMatch[1].trim()
        if (line === '>' || line === '|' || /^[>|]-?$/.test(line)) {
          // YAML 多行折叠（description: > 后接缩进行）→ 收集后续缩进行拼成一句
          const after = fm[1].slice(fm[1].indexOf(descMatch[0]) + descMatch[0].length)
          const lines = after.split('\n').filter((l) => /^\s+\S/.test(l)).map((l) => l.trim())
          return lines.join(' ').replace(/^["']|["']$/g, '').slice(0, 200)
        }
        return line.replace(/^["']|["']$/g, '').slice(0, 200)
      } catch { return '' }
    }
    const result: Array<{ name: string; url: string; description: string }> = []
    for (let i = 0; i < dirs.length; i += 8) {
      const chunk = dirs.slice(i, i + 8)
      const descs = await Promise.all(chunk.map((d: any) => readDesc(d.name)))
      chunk.forEach((d: any, j: number) => {
        result.push({
          name: d.name,
          url: `https://github.com/${repo}/tree/main/${base ? base + '/' : ''}${d.name}`,
          description: descs[j],
        })
      })
    }
    ghReposCache[repo] = { at: Date.now(), data: result }
    ctx.body = result
  } catch (e: any) {
    ctx.status = 502
    ctx.body = { error: e.message }
  }
})

// 搜索 GitHub 第三方技能（必须在 /:id 之前注册，避免 'search' 被当 id 匹配）
router.get('/search', async (ctx) => {
  const q = (ctx.query.q as string || '').trim()
  if (!q) {
    ctx.body = []
    return
  }
  try {
    const results = await searchGitHubSkills(q)
    ctx.body = results
  } catch (err: any) {
    ctx.status = 502
    ctx.body = { error: err.message }
  }
})

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
    globs: typeof body.globs === 'string' ? body.globs : JSON.stringify(body.globs || []),
    environments: body.environments || 'all',
    prompt_template: body.prompt_template || '',
    tools: typeof body.tools === 'string' ? body.tools : JSON.stringify(body.tools || []),
    sort_order: body.sort_order || 0,
    is_builtin: body.is_builtin ? 1 : 0,
    updated_at: new Date().toISOString(),
  }

  db.prepare(`
    INSERT OR REPLACE INTO skills (id, name, description, icon, category, enabled, trigger_keywords, globs, environments, prompt_template, tools, sort_order, is_builtin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    skill.id, skill.name, skill.description, skill.icon, skill.category,
    skill.enabled, skill.trigger_keywords, skill.globs, skill.environments,
    skill.prompt_template, skill.tools,
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

  const allowedFields = ['name', 'description', 'icon', 'category', 'trigger_keywords', 'globs', 'environments', 'prompt_template', 'sort_order']
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

// 安全扫描 GitHub 技能仓库（安装前审计：不安装，只下载扫描）
router.post('/scan', async (ctx) => {
  const { url } = ctx.request.body as { url?: string }
  if (!url) {
    ctx.status = 400
    ctx.body = { error: 'GitHub URL is required' }
    return
  }
  try {
    const report = await scanSkillRepo(url)
    ctx.body = report
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})

// Install skill from GitHub URL（安装前自动安全扫描，danger 拒绝）
router.post('/install', async (ctx) => {
  const { url, workspaceDir, skipScan } = ctx.request.body as { url: string; workspaceDir?: string; skipScan?: boolean }
  if (!url) {
    ctx.status = 400
    ctx.body = { success: false, error: 'GitHub URL is required' }
    return
  }

  try {
    // 安全扫描（除非显式跳过）：danger 级拒绝安装
    if (!skipScan) {
      const report = await scanSkillRepo(url)
      if (report.level === 'danger') {
        ctx.status = 400
        ctx.body = {
          success: false,
          error: '安装已拦截：检测到高危风险',
          scan: report,
        }
        return
      }
    }
    const result = await installSkillFromGitHub(url, workspaceDir || process.cwd())
    if (result.success) {
      ctx.body = { success: true, name: result.name, skills: result.skills || [result.name] }
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

// 导出单个技能为 SKILL.md（Agent Skills 开放标准，主流编码代理/主流编码代理/主流编码代理 可读）
router.post('/export', (ctx) => {
  try {
    const db = getDB()
    const body = ctx.request.body as Record<string, any>
    const workspaceDir = body.workspaceDir || process.cwd()
    const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(body.id) as any
    if (!skill) { ctx.status = 404; ctx.body = { error: 'Skill not found' }; return }
    const path = exportSkillToFile(skill, workspaceDir)
    ctx.body = { success: true, path }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err.message }
  }
})

// 批量导出所有启用技能为 SKILL.md 文件
router.post('/export-all', (ctx) => {
  try {
    const workspaceDir = (ctx.request.body as any).workspaceDir || process.cwd()
    const result = exportAllSkillsToFiles(workspaceDir)
    ctx.body = { success: true, ...result }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, error: err.message }
  }
})

// 初始化内置技能：DB 为空时自动安装核心技能（core=true），其余在市场由用户按需安装；
// 非空时不覆盖用户数据（已卸载的内置技能不会被自动重装，保持"可卸载可重装"语义）
export function seedBuiltinSkills() {
  const db = getDB()
  const count = (db.prepare('SELECT COUNT(*) as c FROM skills').get() as any).c
  if (count > 0) return

  const core = BUILTIN_CATALOG.filter((s) => s.core)
  const stmt = db.prepare(`
    INSERT INTO skills (id, name, description, icon, category, enabled, trigger_keywords, globs, environments, prompt_template, tools, sort_order, is_builtin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `)
  for (const skill of core) {
    stmt.run(
      randomUUID(), skill.name, skill.description, skill.icon,
      skill.category, skill.enabled ? 1 : 0, skill.trigger_keywords,
      JSON.stringify(skill.globs || []), skill.environments || 'all',
      skill.prompt_template, JSON.stringify(skill.tools || []), skill.sort_order
    )
  }
  console.log(`[skills] Seeded ${core.length} core builtin skills`)
}

export default router
