/**
 * Agent 工具定义与执行器
 * 每个工具包含 OpenAI Function Calling 格式的 schema 和执行函数
 */
import { getDB } from './database'
import { runSearchChain, runExhaustiveSearch, SEARCH_PROVIDERS } from './search-providers'
import { memoryRankedSearch, memoryRankedSearchHybrid } from './memory-search'
import { randomUUID } from 'crypto'
import { readFile, writeFile, access, appendFile, stat, readdir, rm, rmdir } from 'fs/promises'
import { exec, execFile, spawn } from 'child_process'
import { constants, readdirSync, statSync } from 'fs'
import { installSkillFromGitHub, initSkillsDirectory } from './skill-loader'
import { basename, join } from 'path'
import { terminalOpen, terminalList, terminalSend, terminalRead, terminalSignal, terminalClose } from './terminal-manager'
import { scanDangerousPath, sandboxify, WORKSPACE_ROOT, assertSafeFilePath } from './sandbox'
// 工具架构轻量包化（2026-08-25 渐进式第一步）：tools/ 目录注册表（ToolDef 标准接口），加工具=加文件
import { directoryTools, directoryExecutors } from '../tools/registry'

/** 读取 settings 表配置（如 tavilyApiKey），空值返回 '' */
function readSetting(key: string): string {
  try {
    const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row?.value ? String(row.value).trim() : ''
  } catch {
    return ''
  }
}

// ============================
// 类型定义
// ============================

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, any>
  category?: 'memory' | 'file' | 'network' | 'system' | 'interaction' | 'git' | 'terminal'
  dangerous?: boolean
}

export interface ToolMeta {
  name: string
  category: 'memory' | 'file' | 'network' | 'system' | 'interaction' | 'git' | 'terminal'
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

/** 工具执行上下文：会话级工作目录（用户新建任务时指定，AI 在该目录干活）+ 默认权限档位 */
export interface ToolExecCtx {
  /** 会话工作目录（绝对路径）；为空则用 WORKSPACE_ROOT */
  cwd?: string
  /** 会话 ID（create_plan 落库任务归属；模型可能不传 args.session_id，由 agent 注入兜底） */
  sessionId?: string
  /** 默认权限档位：workspace-only / sandbox / full（决定沙箱放行范围） */
  permissionLevel?: 'workspace-only' | 'sandbox' | 'full'
  /** 产物上报回调：shell 命令产生/修改的文件（由 agent 持久化到 artifacts 表） */
  onArtifacts?: (files: Array<{ name: string; path: string; action: 'created' | 'updated'; size: number }>) => void
  /** 工具流式输出回调：命令执行分片实时推送（WorkBuddy streamOutput 同款） */
  onOutput?: (toolCallId: string, chunk: string) => void
  /** 实时预览回调：写入 .html 文件时触发（前端右侧边栏实时渲染） */
  onPreview?: (path: string, content: string) => void
  /** 画图回调：AI 生成 SVG 图表时触发（前端聊天内直接渲染） */
  onDiagram?: (title: string, svg: string) => void
  /** 画图流式块回调：SVG 按标签边界切块实时推送（WorkBuddy 同款"先出画板再逐框绘制"——SVG 元素闭合即被浏览器绘制） */
  onDiagramChunk?: (chunk: string) => void
  /** 生图回调：AI 生成图片后推送（dataURL 或 URL + 标题），前端对话内 + 右侧预览展示 */
  onImage?: (data: string, isUrl: boolean, title: string) => void
  /** 文件变更回调：写入文件时触发（前端变更 tab 显示改前/改后 diff） */
  onFileChange?: (path: string, oldContent: string, newContent: string) => void
  /** AskQuestion 回调：Agent 向用户提问，挂起等待答复（由 agent 注入，实现结构化交互） */
  askQuestion?: (id: string, question: string, options?: string[]) => Promise<string>
  /** 提问结果发送回调：把提问/选项推给前端展示 */
  emitQuestion?: (data: { id: string; question: string; options?: string[] }) => void
}

/**
 * ffmpeg 滤镜路径转义（字幕等路径含冒号/引号需转义，避免被 ffmpeg 解析成 URL/参数）
 */
function escapeFfPath(p: string): string {
  return String(p).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/**
 * 扫描目录下文件快照（深度 ≤2，跳过 node_modules/.git/dist 等）：
 * 用于 shell 执行前后对比，识别命令产生/修改的文件
 */
function scanDirFiles(root: string): Map<string, { mtime: number; size: number }> {
  const out = new Map<string, { mtime: number; size: number }>()
  const skip = new Set(['node_modules', '.git', 'dist', '.next', '.cache', '.turbo'])
  const walk = (dir: string, depth: number) => {
    if (depth > 2) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(full, depth + 1)
      } else if (e.isFile()) {
        try {
          const st = statSync(full)
          out.set(full, { mtime: st.mtimeMs, size: st.size })
        } catch {}
      }
    }
  }
  walk(root, 0)
  return out
}

/** 对比两次快照，返回新增/修改的文件 */
function diffFileSnapshots(before: Map<string, { mtime: number; size: number }>, after: Map<string, { mtime: number; size: number }>): Array<{ name: string; path: string; action: 'created' | 'updated'; size: number }> {
  const arts: Array<{ name: string; path: string; action: 'created' | 'updated'; size: number }> = []
  for (const [p, info] of after) {
    const b = before.get(p)
    if (!b) {
      arts.push({ name: basename(p), path: p, action: 'created', size: info.size })
    } else if (Math.abs(b.mtime - info.mtime) > 100 || b.size !== info.size) {
      arts.push({ name: basename(p), path: p, action: 'updated', size: info.size })
    }
  }
  return arts.slice(0, 20)
}

/**
 * 解析文件工具路径：相对路径基于会话工作目录（或默认工作区）解析成绝对路径
 */
function resolvePath(p: string, cwd?: string): string {
  if (!p) return p
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return p
  return join(cwd || WORKSPACE_ROOT, p)
}

type ToolExecutor = (args: Record<string, any>, ctx?: ToolExecCtx) => Promise<string>

/**
 * 记忆内容敏感凭据模式：命中即拒绝明文入库。
 * 覆盖 API Key / Secret / 密码 / 私钥 / Bearer 等常见凭据形态，
 * 刻意不含裸 "token"（避免误伤 "token 数/用量" 等合法语境）。
 */
const SENSITIVE_MEMORY_PATTERN =
  /(app[_-]?secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|password|passwd|passphrase|私钥|密钥|auth(?:orization)?\s*[:=]\s*bearer|BEGIN\s+[A-Z\s]*PRIVATE\s+KEY)/i

/** 执行 git 命令（工作目录执行，输出截断防刷屏；学 Grok AgenticGitAction 的 git 工具封装） */
function runGit(cmd: string, cwd: string | undefined, label: string): Promise<string> {
  return new Promise((resolve) => {
    const dir = cwd || WORKSPACE_ROOT
    exec(cmd, { cwd: dir, timeout: 15000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      const out = (stdout || '').trim()
      const err = (stderr || '').trim()
      if (error) {
        resolve(`❌ ${label}失败: ${err || error.message || 'unknown'} `.slice(0, 400))
        return
      }
      resolve(`${label}完成:\n${(out || err || '(无输出)').slice(0, 800)}`)
    })
  })
}

/** 记忆入库核心：同 key 同内容去重 / 同 key 覆盖 / 新增插入 */
function storeMemory(db: any, key: string, content: string, category?: string, importance?: number): string {
  const existing = db.prepare(
    'SELECT id, importance FROM agent_memory WHERE key = ? AND content = ? LIMIT 1'
  ).get(key, content) as any
  if (existing) {
    const imp = Number(importance || 3)
    if (imp > (existing.importance || 0)) {
      db.prepare('UPDATE agent_memory SET importance = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(imp, existing.id)
    }
    return `✅ 记忆已存在（同 key 同内容），自动去重跳过：${key}`
  }

  const sameKey = db.prepare('SELECT id FROM agent_memory WHERE key = ? LIMIT 1').get(key) as any
  if (sameKey) {
    db.prepare(
      "UPDATE agent_memory SET content = ?, category = ?, importance = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(content, category || 'general', importance || 3, sameKey.id)
    return `✅ 记忆已更新（同 key 覆盖旧值）：${key}`
  }

  const id = randomUUID()
  db.prepare(
    'INSERT INTO agent_memory (id, key, content, category, importance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
  ).run(id, key, content, category || 'general', importance || 3)
  return `✅ 记忆已存储：${key}`
}

/** lint_file 静态检查规则：危险模式 / 凭据 / 括号配对粗检（复用技能安全扫描思路） */
function lintContent(content: string, filePath: string): Array<{ severity: 'error' | 'warning'; line: number; message: string }> {
  const lines = content.split('\n')
  const diags: Array<{ severity: 'error' | 'warning'; line: number; message: string }> = []
  const push = (line: number, severity: 'error' | 'warning', message: string) => {
    diags.push({ severity, line: line + 1, message })
  }
  // 高危：删除根目录/家目录、远程脚本管道执行、反弹 shell、磁盘覆写
  const DANGER: Array<[RegExp, string]> = [
    [/rm\s+-(r|rf|fr)[^|\n]*\s+(\/|\$HOME|~)/, '删除根目录或家目录'],
    [/curl[^|\n]*\|\s*(ba|da)?sh\b/, 'curl 管道执行远程脚本'],
    [/wget[^|\n]*\|\s*(ba|da)?sh\b/, 'wget 管道执行远程脚本'],
    [/base64\s*-d[^|\n]*\|\s*(ba|da)?sh\b/, 'base64 解码后管道执行'],
    [/nc\s+-[^|\n]*\s*-e\b/, 'netcat 反弹 shell'],
    [/mkfs|dd\s+if=.*of=\/dev\//, '格式化/覆写磁盘'],
    [/chmod\s+777\s+(\/|\$HOME|~)/, '对根目录/家目录放权'],
  ]
  // 中危：凭据/待办/权限
  const WARN: Array<[RegExp, string]> = [
    [/sudo\s+rm/, 'sudo 删除（高风险）'],
    [/chmod\s+777\b/, '权限放宽 chmod 777'],
    [/\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASS)\}?/i, '引用环境变量凭据'],
    [/['"][A-Za-z0-9_-]{24,}['"]/, '疑似硬编码密钥/Token'],
    [/TODO|FIXME|HACK/, '遗留待办标记'],
    [/console\.log/, '遗留调试日志 console.log'],
  ]
  lines.forEach((l, i) => {
    for (const [re, msg] of DANGER) if (re.test(l)) push(i, 'error', msg)
    for (const [re, msg] of WARN) if (re.test(l)) push(i, 'warning', msg)
  })
  // 括号配对粗检（js/ts/py 等代码文件；字符串内括号可能误报，仅提示）
  const ext = (filePath.split('.').pop() || '').toLowerCase()
  if (['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'vue', 'py', 'go', 'rs', 'java', 'c', 'cpp'].includes(ext)) {
    const pairs: Array<[string, string, string]> = [
      ['(', ')', '圆括号'],
      ['{', '}', '花括号'],
      ['[', ']', '方括号'],
    ]
    for (const [open, close, name] of pairs) {
      let depth = 0
      for (let i = 0; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === open) depth++
          else if (ch === close) depth--
          if (depth < 0) {
            push(i, 'error', `多余的${name}闭合`)
            depth = 0
          }
        }
      }
      if (depth > 0) push(Math.max(0, lines.length - 1), 'warning', `${name}未闭合（剩余 ${depth} 个）`)
    }
  }
  return diags.slice(0, 50)
}

export const toolExecutors: Record<string, ToolExecutor> = {
  // tools/ 目录注册表工具（ToolDef 标准接口，2026-08-25 工具架构轻量包化；加工具=在 tools/ 加文件）
  ...directoryExecutors,
  // ---- 记忆工具 ----
  async memory_store(args) {
    const db = getDB()
    const key = String(args.key || '').trim()
    const content = String(args.content || '').trim()
    if (!key || !content) return '❌ 记忆存储失败：key 和 content 不能为空'

    // 记忆开关关闭 → 拒绝存取（与 buildSystemPrompt 的"记忆未启用"一致）
    const memRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryEnabled') as any
    if (memRow && memRow.value !== 'true') {
      return '⛔ 记忆功能已关闭（设置 → 记忆 → 记忆开关）。如需使用请先开启。'
    }

    // ① 凭据类关键词拦截/脱敏：默认拦截明文密钥/密码入库；
    //    开启"脱敏 PII"设置（piiMaskingEnabled）时改为自动替换为 [REDACTED] 后入库
    if (SENSITIVE_MEMORY_PATTERN.test(content)) {
      const piiRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('piiMaskingEnabled') as any
      const piiMasking = piiRow ? piiRow.value === 'true' : false
      if (piiMasking) {
        const maskedContent = content.replace(SENSITIVE_MEMORY_PATTERN, '[REDACTED]')
        const maskedKey = key.replace(SENSITIVE_MEMORY_PATTERN, '[REDACTED]')
        return storeMemory(db, maskedKey, maskedContent, args.category, args.importance)
      }
      return '❌ 已拦截：内容疑似包含敏感凭据（API Key / Secret / 密码 / 私钥），禁止明文存储。请改用占位符（如 {{API_KEY}}）或脱敏描述。'
    }

    // ② 同 key 同内容自动去重：已存在则跳过（可更新重要性取最大值）
    return storeMemory(db, key, content, args.category, args.importance)
  },

  async memory_recall(args) {
    const db = getDB()
    const memRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryEnabled') as any
    if (memRow && memRow.value !== 'true') return '⛔ 记忆功能已关闭（设置 → 记忆 → 记忆开关）。'
    // 混合检索：配置了 embedding key 时 FTS5 + 语义余弦融合（α=0.8），否则退化纯 FTS5 ranking
    const rows = await memoryRankedSearchHybrid(String(args.query || ''), args.limit || 5)
    if (rows.length === 0) return '未找到相关记忆。'
    return rows.map((r) => `[${r.key}] (${r.category}, importance:${r.importance}, score:${r.score.toFixed(2)}) ${r.content}`).join('\n')
  },

  async memory_list(_args) {
    const db = getDB()
    const memRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryEnabled') as any
    if (memRow && memRow.value !== 'true') return '⛔ 记忆功能已关闭（设置 → 记忆 → 记忆开关）。'
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

  // ---- AskQuestion：Agent 结构化提问（学 Grok）----
  // 需要关键决策/补充信息时向用户提问，挂起等待答复（超时返回超时标记）
  async ask_question(args, ctx) {
    if (!ctx?.askQuestion || !ctx?.emitQuestion) {
      return '⛔ 当前环境不支持提问交互，请基于现有信息合理假设后继续。'
    }
    const id = `q_${randomUUID()}`
    const question = String(args.question || '').trim()
    if (!question) return '❌ ask_question 需要提供 question 参数'
    // 2026-08-27 修复：options 可能是对象数组（{label/description}/{text} 等），String(对象)=[object Object]
    // → 归一化为字符串数组（与 ask_user 一致）
    const options: string[] = Array.isArray(args.options)
      ? args.options.map((o: any) => {
          if (typeof o === 'string') return o
          if (o == null) return ''
          if (typeof o === 'object') return String(o.label ?? o.text ?? o.value ?? '')
          return String(o)
        }).filter(Boolean)
      : []
    // 推送前端展示
    ctx.emitQuestion({ id, question, options })
    // 挂起等待答复
    const answer = await ctx.askQuestion(id, question, options)
    if (answer === '__timeout__') return '⏰ 用户未在时限内答复，请基于现有信息合理假设后继续。'
    return `用户答复: ${answer}`
  },

  // ---- CreatePlan：Agent 多步骤计划（学 Grok CreatePlan）----
  // 任务较复杂时先创建结构化计划（任务列表 + 子任务），前端以计划卡片展示进度
  // 注：get_goal 已迁至 tools/ 目录（ToolDef 注册表，2026-08-25 工具架构轻量包化示范）
  async create_plan(args, ctx) {
    const db = getDB()
    const title = String(args.title || args.subject || '').trim()
    if (!title) return '❌ create_plan 需要提供 title（计划标题）'
    const steps: Array<{ subject: string; description?: string }> = Array.isArray(args.steps)
      ? args.steps.map((s: any) => (typeof s === 'string' ? { subject: s } : { subject: s.subject || '', description: s.description }))
      : []
    if (steps.length === 0) return '❌ create_plan 需要提供 steps（步骤列表）'

    // 先创建计划根任务（session 归属：模型传的 session_id 优先，否则用 ctx 注入兜底）
    const planSessionId = args.session_id || ctx?.sessionId || null
    const planId = randomUUID()
    db.prepare(
      'INSERT INTO tasks (id, session_id, subject, description, status, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(planId, planSessionId, title, args.description || '', 'in_progress', 0)

    // 每个步骤创建子任务；第一步立即进入 in_progress（驱动前端进度推进）
    const stepIds: string[] = []
    for (let i = 0; i < steps.length; i++) {
      const stepId = randomUUID()
      db.prepare(
        'INSERT INTO tasks (id, session_id, parent_id, subject, description, status, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(stepId, planSessionId, planId, steps[i].subject, steps[i].description || '', i === 0 ? 'in_progress' : 'pending', i + 1)
      stepIds.push(stepId)
    }
    return `📋 计划已创建: "${title}"，共 ${steps.length} 步。\n` + steps.map((s, i) => `  ${i + 1}. [ ] ${s.subject}`).join('\n')
  },

  // ---- Git 操作（学 Grok AgenticGitAction）：commit/diff/status ----
  async git_status(args, ctx) {
    return runGit('git status --short', ctx?.cwd, 'Git 状态')
  },
  async git_diff(args, ctx) {
    const target = args.staged ? '--cached' : ''
    return runGit(`git diff ${target}`, ctx?.cwd, 'Git 变更')
  },
  async git_commit(args, ctx) {
    const msg = String(args.message || '').trim()
    if (!msg) return '❌ git_commit 需要提供 message（提交信息）'
    const parts = [`git add -A`, `git commit -m ${JSON.stringify(msg)}`]
    const cwd = ctx?.cwd || WORKSPACE_ROOT
    const results: string[] = []
    for (const cmd of parts) {
      const r = await runGit(cmd, cwd, cmd.startsWith('git add') ? '暂存' : '提交')
      results.push(r)
      if (r.includes('❌') || r.includes('已拦截')) return results.join('\n')
    }
    return results.join('\n')
  },

  // ---- Computer Use（学 Grok ComputerUse，接入开源 computer-use-mcp）----
  // 仅 permissionLevel=full 时启用；复用工具确认机制（Agent 调用前需用户确认）
  async computer_use(args, ctx) {
    if (ctx?.permissionLevel !== 'full') {
      return '⛔ computer_use 需要 full 权限（设置中把会话权限调到「完全访问」才能操控电脑）\n\n授权路径：对话输入区下方权限选择器 → 选「完全访问」→ 重新发送消息'
    }
    const { callComputerUse } = await import('./computer-use')
    const action = String(args.action || '').trim()
    if (!action) return '❌ computer_use 需要提供 action（screenshot/click/type/key/scroll/move/open）'
    const params = { ...(args.args || {}) }
    try {
      const result = await callComputerUse(action, params)
      return result
    } catch (err: any) {
      const msg = String(err?.message || '')
      // macOS 权限不足（录屏/辅助功能）→ 给出具体授权步骤
      if (/permission|denied|screen recording|accessibility|TCC|not authorized/i.test(msg)) {
        return `❌ computer_use 需要 macOS 权限授权（当前被系统拒绝）\n\n授权步骤：\n1. 打开「系统设置 → 隐私与安全性」\n2. 录屏与屏幕录制：把 SUPERCRZY BOT 加入并开启\n3. 辅助功能：把 SUPERCRZY BOT 加入并开启\n4. 重启应用后重试`
      }
      return `❌ computer_use 调用失败: ${msg}`
    }
  },

  // ---- 文件工具（沙箱路径白名单，支持会话级工作目录） ----
  async file_read(args, ctx) {
    const path = resolvePath(args.path, ctx?.cwd)
    const guard = assertSafeFilePath(path, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
    if (guard) return `❌ 已拦截（沙箱规则）: ${guard}`
    try {
      const content = await readFile(path, 'utf-8')
      // 行号切片（WorkBuddy readFile 同款）：startLine/endLine 只需读指定行范围（省 token + 精确看某段）
      // 返回带行号的文本（"489: ..."），前端据此显示 "已读取 xxx L489-末尾"（readLineRange 解析 startLine/endLine）
      const startLine = Number(args.startLine) || 0
      const endLine = Number(args.endLine) || 0
      if (startLine > 0) {
        const lines = content.split('\n')
        const sIdx = Math.min(Math.max(startLine, 1), lines.length + 1)
        const eIdx = endLine > 0 ? Math.min(endLine, lines.length) : lines.length
        // 截断保护：切片本身也受 maxLength 约束
        const slice = lines.slice(sIdx - 1, eIdx)
        const numbered = slice.map((ln: string, i: number) => `${sIdx + i}: ${ln}`).join('\n')
        return numbered
      }
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

  async lint_file(args, ctx) {
    const path = resolvePath(args.path, ctx?.cwd)
    const guard = assertSafeFilePath(path, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
    if (guard) return `❌ 已拦截（沙箱规则）: ${guard}`
    try {
      const content = await readFile(path, 'utf-8')
      const diagnostics = lintContent(content, path)
      if (diagnostics.length === 0) return '✅ 未发现明显问题'
      return JSON.stringify({ path, count: diagnostics.length, diagnostics })
    } catch (err: any) {
      return `❌ 读取文件失败：${err.message}`
    }
  },

  async file_write(args, ctx) {
    const path = resolvePath(args.path, ctx?.cwd)
    const guard = assertSafeFilePath(path, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
    if (guard) return `❌ 已拦截（沙箱规则）: ${guard}`
    try {
      // 变更对比：写入前读旧内容（存在则 diff 显示"修改"，不存在则是"新增"）
      let oldContent = ''
      try { oldContent = await readFile(path, 'utf-8') } catch { /* 新文件 */ }
      // 写文件格式化（P2-3，WorkBuddy formatters 同款）：JSON 自动规范化缩进（无依赖安全；JS/TS 等需 prettier 暂缓）
      let toWrite = String(args.content ?? '')
      if (/\.json$/i.test(path)) {
        try { toWrite = JSON.stringify(JSON.parse(toWrite), null, 2) + '\n' } catch { /* 非法 JSON 保持原样 */ }
      }
      // 写文件流式化（ChatGPT 同款：写入过程代码实时"长出来"）：分块写入 + onOutput 推送代码内容
      // 每块 25 行 flush，推送带行号进度的代码块 → 前端工具卡片流式区显示行号代码视图（打字机滚动）
      const toWriteStr = String(toWrite ?? '')
      const totalLines = toWriteStr.split('\n').length
      const CHUNK = 12
      const linesArr = toWriteStr.split('\n')
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      // 打字节奏：按块数自适应（ChatGPT 是模型流式天然慢，我们参数一次性到达需模拟）——
      // 块数多则块间快（不拖慢大文件），块数少则块间慢（小文件肉眼可见逐块滚动）
      const numBlocks = Math.max(1, Math.ceil(totalLines / CHUNK))
      const blockDelay = Math.min(200, Math.max(45, Math.round(1400 / numBlocks)))
      // 推送一块代码（带进度头），模拟 ChatGPT 边写边显示
      const emitChunk = (chunkLines: string[], written: number, isFirst: boolean, isLast: boolean) => {
        if (!ctx?.onOutput) return
        const head = `📝 写入 ${written}/${totalLines} 行\n`
        // 代码块格式：进度行 + ``` 代码块（前端按行渲染）
        ctx.onOutput('', `${head}\`\`\`\n${chunkLines.join('\n')}\n\`\`\`\n`)
        void isFirst
        void isLast
      }
      if (linesArr.length <= CHUNK) {
        await writeFile(path, toWriteStr, 'utf-8')
        if (ctx?.onOutput && totalLines > 1) emitChunk(linesArr, totalLines, true, true)
      } else {
        // 首块：writeFile
        const first = linesArr.slice(0, CHUNK)
        await writeFile(path, first.join('\n'), 'utf-8')
        emitChunk(first, CHUNK, true, false)
        await sleep(blockDelay)
        let idx = CHUNK
        while (idx < linesArr.length) {
          const chunk = linesArr.slice(idx, idx + CHUNK).join('\n')
          await appendFile(path, '\n' + chunk, 'utf-8')
          idx += CHUNK
          const written = Math.min(idx, totalLines)
          emitChunk(linesArr.slice(Math.max(0, idx - CHUNK), idx), written, false, written >= totalLines)
          if (written < totalLines) await sleep(blockDelay)
        }
      }
      // 实时预览：写入 html/css/js → 推送给前端（前端收集文件集后内联渲染，支持配套 CSS/JS）
      if (ctx?.onPreview && /\.(html?|css|js)$/i.test(path)) {
        ctx.onPreview(path, String(args.content || '').slice(0, 200000))
      }
      // 变更数据：带 old_str 供前端 diff 对比（变更 tab 显示"改前/改后"）
      if (ctx?.onFileChange) {
        ctx.onFileChange(path, oldContent, String(args.content || ''))
      }
      // 行数统计（WorkBuddy addedLines/deletedLines 同款）：diff 新增/删除行
      const { added, deleted } = diffLines(oldContent, String(args.content || ''))
      return oldContent
        ? `✅ 文件已更新：${path} (${args.content.length} 字符, +${added}/-${deleted} 行)`
        : `✅ 文件已创建：${path} (${args.content.length} 字符, ${added} 行)`
    } catch (err: any) {
      return `❌ 写入文件失败：${err.message}`
    }
  },

  /** 多文件编辑（对齐 WorkBuddy MultiEdit：一次对同一文件做多处 old_str→new_str 替换，返回 edits 统计） */
  async multi_edit(args, ctx) {
    const path = resolvePath(args.file_path || args.path, ctx?.cwd)
    const guard = assertSafeFilePath(path, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
    if (guard) return `❌ 已拦截（沙箱规则）: ${guard}`
    const edits = Array.isArray(args.edits) ? args.edits : []
    if (edits.length === 0) return '❌ 缺少 edits 数组（[{old_str, new_str}]）'
    try {
      const oldContent = await readFile(path, 'utf-8')
      let content = oldContent
      let applied = 0
      const results: Array<{ old_str: string; new_str: string; status: 'applied' | 'not_found' }> = []
      for (const e of edits) {
        const oldStr = String(e.old_str ?? '')
        const newStr = String(e.new_str ?? '')
        if (!oldStr) {
          results.push({ old_str: '', new_str: newStr, status: 'applied' })
          applied++
          continue
        }
        if (content.includes(oldStr)) {
          content = content.replace(oldStr, newStr)
          results.push({ old_str: oldStr, new_str: newStr, status: 'applied' })
          applied++
        } else {
          results.push({ old_str: oldStr, new_str: newStr, status: 'not_found' })
        }
      }
      if (applied === 0) return '❌ 所有修改片段均未找到（内容可能已变化），文件未改动'
      await writeFile(path, content, 'utf-8')
      // 推送 diff 数据（前端 FileDiffViewer 展示改前/改后）
      ctx?.onFileChange?.(path, oldContent, content)
      return `✅ 已应用 ${applied}/${edits.length} 处修改：${path}（${oldContent.length} → ${content.length} 字符，${results.filter((r) => r.status === 'applied').length} 处成功）`
    } catch (err: any) {
      return `❌ 编辑文件失败：${err.message}`
    }
  },

  async draw_diagram(args, ctx) {
    const title = String(args.title || 'diagram').slice(0, 60)
    const svg = String(args.svg || '').trim()
    if (!svg.startsWith('<svg')) return '❌ SVG 必须以 <svg> 开头（不含 xml 声明/DOCTYPE）'
    if (svg.length > 80000) return '❌ SVG 过大（超过 80K 字符），请精简'
    // 安全：只允许 SVG 元素与基础样式属性，禁止 script/外链
    if (/<script|on\w+=|javascript:|href=|<foreignObject/i.test(svg)) {
      return '❌ SVG 含不安全内容（script/事件/外链被禁止），请用纯图形元素'
    }
    // 流式画图（WorkBuddy 同款）：SVG 按标签边界切块推送 → 前端元素逐个闭合逐个绘制（"先画框 A 再画框 B"）
    // 先推空块让"画板"先出现，再逐块绘制
    if (ctx?.onDiagramChunk) {
      const chunks = chunkSvgByTag(svg, 140)
      const delay = chunks.length > 1 ? Math.max(30, Math.min(160, Math.round(1200 / chunks.length))) : 0
      if (delay > 0) ctx.onDiagramChunk('')
      for (const c of chunks) {
        ctx.onDiagramChunk(c)
        if (delay > 0) await new Promise((r) => setTimeout(r, delay))
      }
    }
    ctx?.onDiagram?.(title, svg)
    return `✅ 图表已生成：${title}`
  },

  async file_exists(args, ctx) {
    const path = resolvePath(args.path, ctx?.cwd)
    const guard = assertSafeFilePath(path, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
    if (guard) return `❌ 已拦截（沙箱规则）: ${guard}`
    try {
      await access(path, constants.F_OK)
      return `true - 文件存在：${path}`
    } catch {
      return `false - 文件不存在：${path}`
    }
  },

  // file_delete（2026-08-24 补全：授权逻辑早已按"删文件需确认"设计，工具本体补齐；危险工具走 SENSITIVE_TOOLS 确认）
  async file_delete(args, ctx) {
    const path = resolvePath(args.path, ctx?.cwd)
    const guard = assertSafeFilePath(path, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
    if (guard) return `❌ 已拦截（沙箱规则）: ${guard}`
    try {
      const st = await stat(path)
      if (st.isDirectory()) {
        // 目录删除：仅空目录（防误删整目录树）
        const entries = await readdir(path)
        if (entries.length > 0) return `❌ 目录非空（${entries.length} 项），拒绝删除。请先清空或只删单个文件。`
        await rmdir(path)
        return `✅ 已删除空目录：${path}`
      }
      await rm(path, { force: true })
      return `✅ 已删除文件：${path}`
    } catch (err: any) {
      return `❌ 删除失败：${err.message}`
    }
  },

  // ---- 终端六件套（对齐 Harness tool-terminal：持久会话，仅 full 权限可用）----
  async terminal_open(args, ctx) {
    // 权限校验：仅 full 权限可开持久终端（可交互/写，与 shell_exec 只读互补）
    if (ctx?.permissionLevel !== 'full') {
      return '⛔ 终端会话仅"完全访问"权限可用（设置 → 会话权限 → 允许完全访问）。当前为 ' + (ctx?.permissionLevel || 'unknown')
    }
    const cwd = args.cwd ? resolvePath(args.cwd, ctx?.cwd) : ctx?.cwd
    const res = terminalOpen(cwd, args.shell || '/bin/bash')
    return res.ok ? `✅ 终端会话已打开：${res.id}（cwd: ${cwd || process.cwd()}）。用 terminal_send 发命令、terminal_read 读输出。` : `❌ ${res.error}`
  },

  async terminal_list() {
    const list = terminalList()
    if (list.length === 0) return '当前没有终端会话。用 terminal_open 打开一个。'
    return '终端会话：\n' + list.map((s) => `- ${s.id} [${s.running ? '运行中' : '已退出'}] shell=${s.shell} cwd=${s.cwd}`).join('\n')
  },

  async terminal_send(args) {
    if (!args.id) return '❌ 缺少会话 id'
    const res = terminalSend(String(args.id), String(args.command ?? ''))
    return res.ok ? `✅ 已发送到 ${args.id}（用 terminal_read 读取输出）` : `❌ ${res.error}`
  },

  async terminal_read(args) {
    if (!args.id) return '❌ 缺少会话 id'
    const res = terminalRead(String(args.id), args.offset ? Number(args.offset) : undefined)
    if (!res.ok) return `❌ ${res.error}`
    if (!res.output) return `（${args.id} 暂无新输出）`
    return `${res.output}\n[输出结束 nextOffset=${res.nextOffset}${res.exited ? ' 会话已退出' : ''}]`
  },

  async terminal_signal(args) {
    if (!args.id) return '❌ 缺少会话 id'
    const sig = String(args.signal || 'SIGINT').toUpperCase()
    const res = terminalSignal(String(args.id), sig)
    return res.ok ? `✅ 已发送 ${sig} 到 ${args.id}` : `❌ ${res.error}`
  },

  async terminal_close(args) {
    if (!args.id) return '❌ 缺少会话 id'
    const res = terminalClose(String(args.id))
    return res.ok ? `✅ 已关闭终端会话 ${args.id}` : `❌ ${res.error}`
  },

  // ---- 可视化指南（WorkBuddy visualizer:read_me 同款）----
  /** 读取项目的可视化操作指南（README/SKILL.md 等），帮助 AI 了解当前工作区约定 */
  async read_me(args, ctx) {
    const cwd = ctx?.cwd || WORKSPACE_ROOT
    const candidates = ['README.md', 'README.zh-CN.md', '.agents/skills/README.md', 'SUPERCRZY_AGENT_参考手册.md']
    for (const name of candidates) {
      const p = join(cwd, name)
      const guard = assertSafeFilePath(p, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd, extraAllowed: ctx?.cwd ? [ctx.cwd] : [] })
      if (guard) continue
      try {
        await access(p, constants.F_OK)
        const content = await readFile(p, 'utf-8')
        const max = Math.min(Number(args.maxLength) || 8000, content.length)
        const sliced = content.slice(0, max)
        return `已读取可视化指南：${name}（${content.length} 字符）\n\n${sliced}${max < content.length ? '\n\n…（已截断，共 ' + content.length + ' 字符）' : ''}`
      } catch { /* 尝试下一个 */ }
    }
    return '未找到可视化指南文件（README.md / .agents/skills/README.md）。可先用 file_search 查找项目文档。'
  },

  // ---- 工具发现（2026-08-29 两级加载：重型工具按需暴露 schema） ----
  async tool_search(args) {
    const query = String(args.query || '').trim().toLowerCase()
    const DEFERRED_NAMES = [...DEFERRED_TOOLS]
    const matched = DEFERRED_NAMES.filter(n => !query || n.includes(query))

    if (matched.length === 0) {
      return '未找到匹配的按需工具。核心工具（file_read/file_write/shell_exec/web_search/web_fetch/deep_research 等）已常驻，无需搜索。可按需搜索：' + DEFERRED_NAMES.join(', ')
    }
    const lines = matched.map(n => {
      const def = toolDefinitions.find(t => t.name === n)
      return `- ${n}: ${def?.description || '无描述'}` + (def ? '' : '')
    })
    return `按需工具（已加载，可直接调用）：\n${lines.join('\n')}`
  },

  // ---- Shell 工具（三层沙箱防护） ----
  async shell_exec(args, ctx) {
    // L1 危险命令黑名单：无条件拦截（即使已确认也禁止）
    const cmd = String(args.command || '').trim()
    const BLOCKED = [
      /rm\s+-rf\s+\/\s*(\s|$)/,            // 删除根目录
      /\bmkfs\b/, /\bdd\s+if=/, /\bshutdown\b/, /\breboot\b/,
      /\bsudo\b/, /\brm\s+-rf\s+~/, /\bchmod\s+-R\s+777\s+\//,
      /:[\(\|][:\|]\{/,                      // fork 炸弹
      /\b(curl|wget)\b.*\|\s*(ba)?sh\b/,    // 下载即执行
      /\bbase64\s+-d\b.*\|\s*(ba)?sh\b/,
    ]
    for (const pattern of BLOCKED) {
      if (pattern.test(cmd)) {
        return `❌ 已拦截危险命令（禁止执行）: ${cmd.slice(0, 80)}`
      }
    }

    // L2 软沙箱：危险路径扫描（.ssh/.aws/.env、home 白名单外绝对路径等，按会话权限档位）
    const danger = scanDangerousPath(cmd, { level: ctx?.permissionLevel, workspaceDir: ctx?.cwd })
    if (danger) {
      return `❌ 已拦截（沙箱规则）: ${danger}\n命令: ${cmd.slice(0, 80)}`
    }

    // L3 硬沙箱：sandbox-exec 内核级隔离（不可用时自动降级，仍保留 L1/L2）
    const sb = await sandboxify(cmd)
    if (!sb.sandboxed && sb.reason) {
      console.warn(`[Sandbox] ${sb.reason}，命令以软沙箱保护执行: ${cmd.slice(0, 60)}`)
    }

    // 产物快照：执行前扫描工作目录（命令可能生成/修改文件 → 补录产物）
    const scanRoot = ctx?.cwd || WORKSPACE_ROOT
    const beforeSnap = ctx?.onArtifacts ? scanDirFiles(scanRoot) : null

    return new Promise((resolve) => {
      const timeout = args.timeout || 30000
      // 会话级工作目录：AI 在用户指定的文件夹里执行命令（默认项目工作区）
      const cwd = ctx?.cwd || WORKSPACE_ROOT
      // 流式执行：spawn 分片输出（tool_output SSE 实时推送），同时收集完整输出做最终结果
      let stdoutBuf = ''
      let stderrBuf = ''
      const stream = (chunk: string) => {
        if (ctx?.onOutput) ctx.onOutput('', chunk)
      }
      const finish = (code: number | null, signal: string | null, spawnErr?: Error) => {
        // 执行后对比：命令产生的文件补录为产物
        if (beforeSnap && ctx?.onArtifacts) {
          try {
            const afterSnap = scanDirFiles(scanRoot)
            const arts = diffFileSnapshots(beforeSnap, afterSnap)
            if (arts.length > 0) ctx.onArtifacts(arts)
          } catch {}
        }
        if (spawnErr) {
          resolve(`❌ 命令启动失败: ${spawnErr.message}`)
        } else if (code !== 0) {
          // 部分成功回传（WorkBuddy isPartial 同款）：失败也保留已产生的部分输出
          resolve(`❌ 命令执行失败 (exit code ${code}):\n${stderrBuf || '无错误输出'}${stdoutBuf ? `\n--- 已产生的部分输出 ---\n${stdoutBuf.slice(0, 4000)}` : ''}`)
        } else {
          const output = stdoutBuf + (stderrBuf ? `\n[stderr]\n${stderrBuf}` : '')
          resolve(output.slice(0, 8000) || '(无输出)')
        }
      }
      const opts = { cwd, env: { ...process.env } as NodeJS.ProcessEnv }
      const child = (sb.sandboxed && sb.args)
        ? spawn(sb.exec, sb.args, opts)
        : spawn(cmd, { ...opts, shell: true })
      const killTimer = setTimeout(() => { child.kill(); finish(-1, null) }, timeout)
      child.stdout?.on('data', (d: Buffer) => { const s = d.toString(); stdoutBuf += s; stream(s) })
      child.stderr?.on('data', (d: Buffer) => { const s = d.toString(); stderrBuf += s; stream(s) })
      child.on('error', (err) => { clearTimeout(killTimer); finish(-1, null, err) })
      child.on('close', (code, signal) => { clearTimeout(killTimer); finish(code, signal) })
    })
  },

  // ---- 视频/音频剪辑工具（ffmpeg）----
  async video_edit(args, ctx) {
    const op = String(args.op || '').trim()
    const output = String(args.output || '').trim()
    const cwd = ctx?.cwd || WORKSPACE_ROOT
    // ffmpeg 路径：设置 ffmpegPath 可自配，否则用内置 bin/ffmpeg（随包分发，用户免安装）
    const ffmpegPath = readSetting('ffmpegPath') || join(process.cwd(), 'bin', 'ffmpeg')
    // 输出路径必须在工作区（防越权写盘）
    try { assertSafeFilePath(output, { workspaceDir: cwd }) } catch (e: any) { return `❌ 输出路径不在允许的工作区: ${output}` }
    if (!op) return '❌ video_edit 需要 op 参数（trim/concat/convert/compress/extract/subtitle）'

    // 校验输入路径在工作区内
    const checkInput = (p: string) => {
      if (!p) return ''
      try { assertSafeFilePath(p, { workspaceDir: cwd }); return '' } catch (e: any) { return `输入路径不合法: ${p}` }
    }
    const err = (args.input ? checkInput(String(args.input)) : '') || (args.subtitle_file ? checkInput(String(args.subtitle_file)) : '')
    if (err) return `❌ ${err}`
    if (Array.isArray(args.inputs)) for (const p of args.inputs) { const e2 = checkInput(String(p)); if (e2) return `❌ ${e2}` }

    // 构建 ffmpeg 参数（用数组，不拼接 shell，防注入）
    const out = `-y ${output}`  // -y 覆盖
    const buildArgs = (): string[] => {
      const a = ['-y']
      const inputs = (Array.isArray(args.inputs) && args.inputs.length) ? args.inputs.map(String) : (args.input ? [String(args.input)] : [])
      for (const inp of inputs) { a.push('-i', inp) }
      switch (op) {
        case 'trim': {
          if (args.time_start) { a.push('-ss', String(args.time_start)) }
          if (args.time_end) { a.push('-to', String(args.time_end)) }
          a.push('-c', 'copy', output)
          break
        }
        case 'convert': case 'compress': {
          if (args.width && args.height) { a.push('-vf', `scale=${args.width}:${args.height}`) }
          else if (args.width) { a.push('-vf', `scale=${args.width}:-2`) }
          else if (args.height) { a.push('-vf', `scale=-2:${args.height}`) }
          if (args.fps) { a.push('-r', String(args.fps)) }
          if (args.codec) { a.push('-c:v', String(args.codec)) }
          if (op === 'compress' && !args.codec) { a.push('-c:v', 'libx264', '-crf', '23', '-preset', 'medium') }
          a.push(output)
          break
        }
        case 'extract': {
          const t = String(args.time || '5')
          a.push('-ss', t, '-vframes', '1', output)
          break
        }
        case 'subtitle': {
          if (args.subtitle_file) { a.push('-vf', `subtitles=${escapeFfPath(String(args.subtitle_file))}`) }
          a.push('-c', 'copy', output)
          break
        }
        case 'concat': {
          // 用 concat demuxer：生成 list 文件（inputs 每行 file '...'）
          const listPath = join(cwd, `.concat_${Date.now()}.txt`)
          require('fs').writeFileSync(listPath, (Array.isArray(args.inputs) ? args.inputs : []).map(p => `file '${String(p).replace(/'/g, "\\'")}'`).join('\n'), 'utf-8')
          a.push('-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output)
          break
        }
        default: return []
      }
      return a
    }
    const ffArgs = buildArgs()
    if (!ffArgs.length) return `❌ 未知的 op: ${op}`
    const cmd = `${ffmpegPath} ${ffArgs.join(' ')}`
    const danger = scanDangerousPath(cmd, { level: ctx?.permissionLevel, workspaceDir: cwd })
    if (danger) return `❌ 已拦截（沙箱规则）: ${danger}`
    return new Promise((resolve) => {
      let buf = ''
      let errBuf = ''
      const stream = (c: string) => { if (ctx?.onOutput) ctx.onOutput('', c) }
      const child = spawn(ffmpegPath, ffArgs, { cwd, env: { ...process.env } as NodeJS.ProcessEnv })
      const killTimer = setTimeout(() => { child.kill(); resolve(`❌ 剪辑超时（>${Math.round((args.timeout||120000)/1000)}s），已终止`) }, args.timeout || 120000)
      child.stdout?.on('data', (d: Buffer) => { const s = d.toString(); buf += s; stream(s) })
      child.stderr?.on('data', (d: Buffer) => { const s = d.toString(); errBuf += s; stream(s) })
      child.on('error', (e) => { clearTimeout(killTimer); resolve(`❌ ffmpeg 启动失败: ${e.message}`) })
      child.on('close', (code) => {
        clearTimeout(killTimer)
        if (ctx?.onFileChange && op !== 'extract') { try { ctx.onFileChange(output, '', output) } catch {} }
        if (ctx?.onArtifacts) {
          try { ctx.onArtifacts([{ name: basename(output), path: output, action: 'created', size: require('fs').existsSync(output) ? require('fs').statSync(output).size : 0 }]) } catch {}
        }
        resolve(code === 0 ? `✅ 剪辑完成，输出: ${output}（${op}）` : `❌ ffmpeg 失败 (exit ${code}):\n${errBuf.slice(0, 1500) || buf.slice(0, 1500)}`)
      })
    })
  },

  // ---- AI 生图工具（多 provider：pollinations 免key / doubao 豆包 / gemini 谷歌）----
  async generate_image(args, ctx) {
    const prompt = String(args.prompt || '').trim()
    if (!prompt) return '❌ generate_image 需要 prompt 参数（画面描述）'
    const width = Number(args.width) || 1024
    const height = Number(args.height) || 1024
    // provider 选择：显式传 provider > 设置 imageProvider > 默认 pollinations(免key)
    const configured = readSetting('imageProvider') || 'pollinations'
    const provider = (args.provider || configured || 'pollinations').toLowerCase()
    const apiKey = readSetting('imageApiKey') || ''
    const doubaoModel = readSetting('doubaoModel') || 'doubao-seedream-5-0-260128'
    const geminiModel = readSetting('geminiImageModel') || 'gemini-2.5-flash-image'
    const title = String(args.description || prompt).slice(0, 40)
    // 产物落盘目录（工作区内）
    const cwd = ctx?.cwd || WORKSPACE_ROOT
    const fileName = `generated_${Date.now()}.png`
    const outPath = join(cwd, fileName)
    try { assertSafeFilePath(outPath, { workspaceDir: cwd }) } catch (e: any) { return `❌ 输出路径不允许: ${fileName}` }
    const stream = (c: string) => { if (ctx?.onOutput) ctx.onOutput('', c) }
    const pushImage = (data: string, isUrl: boolean) => { stream(isUrl ? `已生成图: ${data.slice(0, 120)}` : '图片已生成'); try { if (ctx?.onImage) ctx.onImage(data, isUrl, title) } catch {} }

    try {
      let imageData = ''  // dataURL 或 URL
      let isUrl = false
      if (provider === 'doubao') {
        // 火山方舟 Seedream：OpenAI 兼容 images/generations
        if (!apiKey) return '❌ doubao provider 需要先在设置里填 API key（火山方舟 ARK API Key）'
        const resp = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: doubaoModel, prompt, size: '1K', response_format: 'url', watermark: false }),
        })
        if (!resp.ok) return `❌ 豆包生图失败: ${resp.status} ${(await resp.text()).slice(0, 200)}`
        const data = await resp.json() as any
        const url = data?.data?.[0]?.url
        if (!url) return '❌ 豆包生图未返回图片 URL'
        imageData = url; isUrl = true
      } else if (provider === 'gemini') {
        // 谷歌 Gemini Nano Banana：generateContent，返回 base64 PNG
        if (!apiKey) return '❌ gemini provider 需要先在设置里填 API key（Google AI Studio）'
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
        })
        if (!resp.ok) return `❌ Gemini 生图失败: ${resp.status} ${(await resp.text()).slice(0, 200)}`
        const data = await resp.json() as any
        const part = data?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inline_data?.data)
        if (!part?.inline_data?.data) return '❌ Gemini 未返回图片'
        imageData = `data:image/${(part.inline_data.mimeType || 'png').replace('image/', '')};base64,${part.inline_data.data}`; isUrl = false
      } else if (provider === 'stability') {
        // Stability AI：multipart/form-data，返回图片二进制
        if (!apiKey) return '❌ stability provider 需要填 Stability API key'
        const form = new FormData()
        form.append('prompt', prompt)
        form.append('aspect_ratio', '1:1')
        form.append('output_format', 'png')
        const resp = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'image/*' },
          body: form,
        })
        if (!resp.ok) return `❌ Stability 生图失败: ${resp.status} ${(await resp.text()).slice(0, 200)}`
        const buf = Buffer.from(await resp.arrayBuffer())
        imageData = `data:image/png;base64,${buf.toString('base64')}`; isUrl = false
      } else if (provider === 'openai' || provider === 'dalle' || provider === 'gpt-image') {
        // OpenAI gpt-image-1（DALL-E API 已下线，用 gpt-image-1 替代）：返回 base64 或 URL
        if (!apiKey) return '❌ openai provider 需要填 OpenAI API key'
        const model = readSetting('openaiImageModel') || 'gpt-image-1'
        const resp = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, prompt, size: '1024x1024', response_format: 'b64_json' }),
        })
        if (!resp.ok) return `❌ OpenAI 生图失败: ${resp.status} ${(await resp.text()).slice(0, 200)}`
        const data = await resp.json() as any
        const b64 = data?.data?.[0]?.b64_json || data?.data?.[0]?.url
        if (!b64) return '❌ OpenAI 未返回图片'
        if (data.data[0].b64_json) { imageData = `data:image/png;base64,${b64}`; isUrl = false }
        else { imageData = b64; isUrl = true }
      } else if (provider === 'replicate') {
        // Replicate FLUX：异步创建 prediction + 轮询
        if (!apiKey) return '❌ replicate provider 需要填 Replicate API token'
        const version = readSetting('replicateModel') || 'black-forest-labs/flux-schnell'
        const pred = await fetch('https://api.replicate.com/v1/predictions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'Prefer': 'wait' },
          body: JSON.stringify({ version, input: { prompt, width, height } }),
        })
        if (!pred.ok) return `❌ Replicate 创建失败: ${pred.status} ${(await pred.text()).slice(0, 200)}`
        const p = await pred.json() as any
        const out = p?.output?.[0] || (Array.isArray(p?.output) ? p.output[0] : null)
        if (out) { imageData = String(out); isUrl = true }
        else if (p?.outputs && Array.isArray(p.outputs)) { imageData = String(p.outputs[0]); isUrl = true }
        else return '❌ Replicate 未返回图片'
      } else {
        // Pollinations 免 key（也作兜底）：纯 URL 拉图
        imageData = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true`; isUrl = true
      }
      // 落盘 & 上报（pollinations 下载 / doubao下载 / gemini已有dataURL）
      try {
        if (isUrl) {
          const resp = await fetch(imageData)
          if (resp.ok) { const buf = Buffer.from(await resp.arrayBuffer()); require('fs').writeFileSync(outPath, buf) }
        } else {
          const base64 = imageData.slice(imageData.indexOf(',') + 1)
          require('fs').writeFileSync(outPath, Buffer.from(base64, 'base64'))
        }
      } catch {}
      if (ctx?.onArtifacts) { try { ctx.onArtifacts([{ name: fileName, path: outPath, action: 'created', size: require('fs').existsSync(outPath) ? require('fs').statSync(outPath).size : 0 }]) } catch {} }
      pushImage(imageData, isUrl)
      return `✅ 图片已生成（${provider}）: ${fileName}${isUrl ? `\nURL: ${imageData.slice(0,150)}` : ''}`
    } catch (e: any) {
      return `❌ 生图失败: ${e.message}`
    }
  },

  // ---- 网页工具 ----
  async web_fetch(args) {
    // 抓取分层（对齐 WorkBuddy WebFetch 能力）：
    // 1) Jina Reader 官方端点（配置 jinaApiKey → Authorization Bearer，更稳定，免费 100w token/月）
    // 2) Jina Reader 免费层（无 key 兜底，服务端渲染 JS → Markdown，解决 403/SPA 空白）
    // 3) 原生 fetch + 文本提取（轻量兜底）
    // 4) 无头浏览器渲染（Chrome headless 兜底，JS 重页面/SPA 也能抓到 DOM）
    const rawUrl = String(args.url || '').trim()
    if (!rawUrl) return '❌ 缺少 URL 参数'
    const maxLen = args.maxLength || 8000
    const jinaKey = readSetting('jinaApiKey')
    try {
      // ---- 1) Jina Reader 官方端点（带 key）----
      if (jinaKey) {
        try {
          const jr = await fetch(`https://r.jina.ai/${encodeURIComponent(rawUrl)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUPERCRZY-BOT/1.0)', 'Accept': 'text/markdown, text/plain', 'Authorization': `Bearer ${jinaKey}` },
            redirect: 'follow',
            signal: AbortSignal.timeout(20000),
          })
          if (jr.ok) {
            const md = await jr.text()
            if (md && md.trim().length > 20) {
              return buildWebFetchResult(parseWebPageMeta(md.trim()), rawUrl, maxLen)
            }
          }
        } catch {}
      }

      // ---- 2) Jina Reader 免费层 ----
      try {
        const jr = await fetch(`https://r.jina.ai/${encodeURIComponent(rawUrl)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SUPERCRZY-BOT/1.0)', 'Accept': 'text/markdown, text/plain' },
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        })
        if (jr.ok) {
          const md = await jr.text()
          if (md && md.trim().length > 20) {
            return buildWebFetchResult(parseWebPageMeta(md.trim()), rawUrl, maxLen)
          }
        }
      } catch {}

      // ---- 3) 原生 fetch ----
      const response = await fetch(rawUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(15000),
      })
      const contentType = response.headers.get('content-type') || ''

      if (!response.ok) {
        // 403/5xx → 交给无头浏览器（反爬/需要 JS）
        return webFetchChromeFallback(rawUrl, maxLen)
      }

      if (contentType.includes('text/html') || contentType.includes('text/plain')) {
        const text = await response.text()
        // 简单提取文本（去除HTML标签）
        const plainText = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        if (plainText.length < 50) return webFetchChromeFallback(rawUrl, maxLen) // 内容太少 → 可能 JS 渲染
        return buildWebFetchResult({ content: plainText }, rawUrl, maxLen)
      } else if (contentType.includes('application/json')) {
        const json = await response.json()
        const content = JSON.stringify(json, null, 2)
        return buildWebFetchResult({ content }, rawUrl, maxLen)
      } else {
        return `无法解析的内容类型: ${contentType}，状态码: ${response.status}`
      }
    } catch (err: any) {
      // fetch 异常（网络/超时）→ 最后尝试无头浏览器
      try { return await webFetchChromeFallback(rawUrl, maxLen) } catch { return `❌ 获取网页失败：${err.message}` }
    }
  },

  async web_search(args) {
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

  // ---- P1 Deep Research Engine：深度研究（多轮递归搜索+提炼 → 3+ 页报告） ----
  async deep_research(args, ctx) {
    const query = String(args.query || '').trim()
    if (!query) return '❌ 缺少参数 query（研究主题）'
    const breadth = Math.min(Math.max(parseInt(args.breadth) || 4, 2), 6)
    const depth = Math.min(Math.max(parseInt(args.depth) || 2, 1), 3)
    try {
      const { runDeepResearch } = await import('./deep-research.js')
      const progress = (p: any) => {
        const line = `[深度研究] 深度 ${p.currentDepth}/${p.totalDepth} · 查询 ${p.completedQueries}/${p.totalQueries || '?'} · 当前：${p.currentQuery || '…'}\n`
        ctx?.onOutput?.('', line)
      }
      const result = await runDeepResearch({ query, breadth, depth, onProgress: progress })
      return JSON.stringify({
        engine: 'deep-research',
        learnings: result.learnings,
        visitedUrls: result.visitedUrls,
        report: result.report,
        summary: `深度研究完成：${result.learnings.length} 条学习点、${result.visitedUrls.length} 个来源、报告 ${result.report.length} 字符`,
      })
    } catch (err: any) {
      return `❌ 深度研究失败：${err.message}`
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
  async ask_user(args, ctx) {
    // 对齐 ask_question：走提问交互链路（前端 QuestionFloating 弹窗），挂起等待答复。
    // 2026-08-27 修复：原 return `__ASK_USER__` 标记从未被 agent 拦截 → 前端无 UI，是被遗忘的死工具。
    if (!ctx?.askQuestion || !ctx?.emitQuestion) {
      return '⛔ 当前环境不支持提问交互，请基于现有信息合理假设后继续。'
    }
    const id = `q_${randomUUID()}`
    const question = String(args.question || args.prompt || '').trim()
    if (!question) return '❌ ask_user 需要提供 question 参数'
    // 2026-08-27 修复：options schema 是对象数组 {label, description}，不能 String(对象)（= [object Object]）
    // → 提取 label/文本字段为字符串
    const options: string[] = Array.isArray(args.options)
      ? args.options.map((o: any) => {
          if (typeof o === 'string') return o
          if (o == null) return ''
          if (typeof o === 'object') return String(o.label ?? o.text ?? o.value ?? '')
          return String(o)
        }).filter(Boolean)
      : []
    // 推送前端展示
    ctx.emitQuestion({ id, question, options })
    // 挂起等待答复（与 ask_question 同一条超时逻辑）
    const answer = await ctx.askQuestion(id, question, options)
    if (answer === '__timeout__') return '⏰ 用户未在时限内答复，请基于现有信息合理假设后继续。'
    return `用户答复: ${answer}`
  },
}

// ============================
// web_fetch 结构化辅助（模块顶层；被 toolExecutors.web_fetch 调用，函数声明提升）
// ============================

/** 搜索结果后处理：过滤空条目 + 同域名最多 2 条 + 标题相似去重 + 有日期的排前；maxAgeDays>0 时剔除超期结果（防抓老信息） */
export function postProcessSearchResults<T extends { title: string; url: string; description?: string; date?: string }>(results: T[], limit: number, maxAgeDays = 0): T[] {
  let list = results.filter((r) => r.title && r.url && r.title !== 'Object moved')
  // 时间过滤：有明确日期且超期的剔除；2026-08-25 修复——无日期/日期无效的从"豁免保留"改为"降权排尾"，
  // 避免 21 号这类无日期旧闻混在时效结果前列（有合格日期的前置，模型优先看到日期干净的）；
  // 当天确实无合格结果时回退全量（保底不空手，date 缺失由工具描述约束模型"标日期未知，勿逐个核实"）
  if (maxAgeDays > 0) {
    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000
    const dated = list.filter((r) => {
      if (!r.date) return false
      const t = new Date(r.date).getTime()
      return !isNaN(t) && t >= cutoff
    })
    const undated = list.filter((r) => {
      if (!r.date) return true
      return isNaN(new Date(r.date).getTime())
    })
    // 有合格日期的前置；无合格日期时只留无日期的（超期的一律剔除——宁可空手，不让昨天/更早的旧闻混入"今天"）
    list = dated.length > 0 ? [...dated, ...undated] : undated
  }
  // 同域名去重（最多 2 条）
  const seenHost = new Map<string, number>()
  list = list.filter((r) => {
    try {
      const host = new URL(r.url).hostname.replace(/^www\./, '')
      const n = seenHost.get(host) || 0
      if (n >= 2) return false
      seenHost.set(host, n + 1)
      return true
    } catch { return true }
  })
  // 标题相似去重（归一化后前 12 字符相同视为重复）
  const titleSeen = new Set<string>()
  list = list.filter((r) => {
    const key = r.title.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '').slice(0, 12)
    if (!key || titleSeen.has(key)) return false
    titleSeen.add(key)
    return true
  })
  // 有日期的优先（新鲜度排序；日期无效的按 0 处理排最后——配合上方"无日期降权"）
  list.sort((a, b) => {
    const da = a.date && !isNaN(new Date(a.date).getTime()) ? new Date(a.date).getTime() : 0
    const db = b.date && !isNaN(new Date(b.date).getTime()) ? new Date(b.date).getTime() : 0
    return db - da
  })
  return list.slice(0, limit)
}

/** 无头浏览器兜底：系统 Chrome headless dump-dom 渲染 JS 页面（SPA/登录页/反爬）→ 提取正文 */
async function webFetchChromeFallback(rawUrl: string, maxLen: number): Promise<string> {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  const chrome = candidates.find((p) => { try { return statSync(p).isFile() } catch { return false } })
  if (!chrome) return `❌ 获取网页失败：所有抓取策略均失败（无可用浏览器渲染）`

  const dom = await new Promise<string>((resolve, reject) => {
    execFile(chrome, ['--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--dump-dom', '--virtual-time-budget=10000', rawUrl], {
      timeout: 30000,
      maxBuffer: 20 * 1024 * 1024,
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)))
  })
  const plainText = dom.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!plainText) throw new Error('浏览器渲染后无内容')
  return buildWebFetchResult({ content: plainText }, rawUrl, maxLen)
}

/** 解析 Jina Reader 返回的 Markdown 头部元信息（Title / URL Source / Published Time / Markdown Content） */
function parseWebPageMeta(md: string): { title?: string; sourceUrl?: string; publishedTime?: string; content: string } {
  const lines = md.split('\n')
  let title: string | undefined
  let sourceUrl: string | undefined
  let publishedTime: string | undefined
  let i = 0
  for (; i < Math.min(lines.length, 12); i++) {
    const l = lines[i]
    if (l.startsWith('Title:')) title = l.slice(6).trim() || undefined
    else if (l.startsWith('URL Source:')) sourceUrl = l.slice(11).trim() || undefined
    else if (l.startsWith('Published Time:')) publishedTime = l.slice(15).trim() || undefined
    else if (l.startsWith('Markdown Content:')) {
      i++
      break
    }
  }
  const content = lines.slice(i).join('\n').trim()
  return { title, sourceUrl, publishedTime, content }
}

/** web_fetch 结构化结果（WorkBuddy WebFetchCompactRenderer 同款：{title,url,publishedTime,content,truncated} 供前端解构展示） */
function buildWebFetchResult(meta: { title?: string; sourceUrl?: string; publishedTime?: string; content: string }, rawUrl: string, maxLen: number) {
  const content = meta.content || '(空内容)'
  const truncated = content.length > maxLen
  const body = truncated ? content.slice(0, maxLen) : content
  return JSON.stringify({
    ok: true,
    url: meta.sourceUrl || rawUrl,
    title: meta.title || '',
    publishedTime: meta.publishedTime || '',
    content: body,
    truncated,
    totalLength: content.length,
  })
}

/**
 * SVG 按标签边界切块（流式画图用）：优先在 `>` 标签闭合处切，保证每块是完整的元素前缀。
 * SVG 声明式渲染：块到达后已闭合元素立即绘制 → 前端呈现"逐框绘制"效果。
 */
function chunkSvgByTag(svg: string, targetChars = 140): string[] {
  const chunks: string[] = []
  let i = 0
  const len = svg.length
  while (i < len) {
    let end = Math.min(i + targetChars, len)
    if (end < len) {
      const gt = svg.indexOf('>', end)
      // 标签闭合处优先；若太远（超 3 倍预算）则按字符硬切（文本节点）
      if (gt !== -1 && gt - i <= targetChars * 3) end = gt + 1
    }
    chunks.push(svg.slice(i, end))
    i = end
  }
  return chunks
}

// ============================
// 工具定义（OpenAI Function Calling Schema）
// ============================

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'tool_search',
    description: '发现按需加载的工具。核心工具已常驻无需搜索；当需要一个不在当前可用列表里的工具（如生成图片 generate_image、视频剪辑 video_edit、终端控制 terminal_*、桌面控制 computer_use、技能详情 skill_view 等）时，先用本工具搜索并加载其定义，随后即可正常调用。支持模糊匹配。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '工具名或关键词，如 "image"、"terminal"、"git"；空则列出所有按需工具' },
      },
      required: ['query'],
    },
  },
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
    description: '读取本地文件内容。支持文本文件。读取大文件时可用 startLine/endLine 只读取指定行范围（省 token 且能精确看某段代码），返回内容带行号；不传则读取全文（maxLength 以内）。',
    category: 'file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件绝对路径' },
        maxLength: { type: 'number', description: '最大读取字符数，默认10000' },
        startLine: { type: 'number', description: '起始行号（从1开始）' },
        endLine: { type: 'number', description: '结束行号（含），不传表示读到文件末尾' },
      },
      required: ['path'],
    },
  },
  {
    name: 'lint_file',
    description: '对文件做静态检查：危险模式（rm -rf 根目录/curl 管道执行等）、凭据泄露、括号配对粗检。写完代码后调用，返回诊断列表（severity/line/message）。',
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
    name: 'file_write',
    description: '写入/创建文件到本地磁盘（支持流式行数进度显示）。**写文件必须使用本工具**——不要用 shell_exec 通过 echo/cat/heredoc 等命令写文件；shell_exec 只用于执行命令。',
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
    name: 'multi_edit',
    description: '对同一文件做多处精确替换（一次调用完成多处修改，比多次 file_write 高效）。每处用 old_str 定位、new_str 替换，全部成功后统一写入。',
    category: 'file',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '文件绝对路径' },
        edits: {
          type: 'array',
          description: '修改列表',
          items: {
            type: 'object',
            properties: {
              old_str: { type: 'string', description: '要查找的原文片段（必须精确匹配）' },
              new_str: { type: 'string', description: '替换后的新片段' },
            },
            required: ['old_str', 'new_str'],
          },
        },
      },
      required: ['file_path', 'edits'],
    },
  },
  {
    name: 'draw_diagram',
    description: '绘制矢量图（架构图/流程图/对比示意图）。直接给出完整 SVG 代码，会实时显示在对话中。适合解释概念、展示方案、画架构。viewBox 建议 0 0 680 420。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '图标题（简短）' },
        svg: { type: 'string', description: '完整 SVG 代码（以 <svg 开头，不含 xml 声明）' },
      },
      required: ['title', 'svg'],
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
      required: ['path'],    },
  },
  {
    name: 'file_delete',
    description: '删除文件或空目录（危险工具：删除前会弹授权确认）。目录仅支持删除空目录，非空拒绝。',
    category: 'file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要删除的文件/空目录绝对路径' },
      },
      required: ['path'],
    },
  },
  {
    name: 'terminal_open',
    description: '打开一个持久终端会话（仅完全访问权限）。与 shell_exec 一次性执行不同：终端可后台运行长任务、运行交互式程序、多次读取输出。返回会话 id。',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '可选：工作目录（默认当前会话工作区）' },
        shell: { type: 'string', description: '可选：shell 路径（默认 /bin/bash）' },
      },
    },
  },
  {
    name: 'terminal_list',
    description: '列出当前所有终端会话（id/运行状态/shell/cwd）。',
    category: 'terminal',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'terminal_send',
    description: '向终端会话发送命令（追加换行执行）。适合长任务后台运行（如启动 dev server）、交互式程序。',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '终端会话 id（terminal_open 返回）' },
        command: { type: 'string', description: '要执行的命令' },
      },
      required: ['id', 'command'],
    },
  },
  {
    name: 'terminal_read',
    description: '增量读取终端会话输出（从上次读取位置；返回 nextOffset 供下次续读）。',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '终端会话 id' },
        offset: { type: 'number', description: '可选：起始读取位置（默认上次消费位置）' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_signal',
    description: '向终端会话发送信号：SIGINT 中断当前命令（Ctrl-C）、SIGTERM 终止等。',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '终端会话 id' },
        signal: { type: 'string', description: '信号名：SIGINT（默认）/ SIGTERM / SIGHUP 等' },
      },
      required: ['id'],
    },
  },
  {
    name: 'terminal_close',
    description: '关闭终端会话（SIGTERM + 1s 强杀兜底）。',
    category: 'terminal',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '终端会话 id' },
      },
      required: ['id'],
    },
  },
  {
    name: 'read_me',
    description: '读取项目的可视化操作指南（README.md / .agents/skills/README.md 等），了解当前工作区的约定、目录结构和用法。适合任务开始前快速了解项目背景。',
    category: 'file',
    parameters: {
      type: 'object',
      properties: {
        maxLength: { type: 'number', description: '最大读取字符数，默认 8000' },
      },
    },
  },
  {
    name: 'shell_exec',
    description: '执行 Shell 命令并获取输出。仅限只读/查询类命令（查看、搜索、测试、构建）。**严禁用 echo/cat/heredoc 等命令写文件或改文件**——写文件请用 file_write 工具。输出限制 8000 字符。**必须提供 description 参数**：用一句话说明本命令要做什么（如"运行查看 deeplink.ts 实际位置"），前端用它作为命令卡片标题。',
    category: 'system',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '本命令目的的一句话说明（人类可读标题，如"查看 ChatView.vue 的滚动逻辑"）' },
        command: { type: 'string', description: '要执行的Shell命令' },
        timeout: { type: 'number', description: '超时毫秒数，默认30000' },
      },
      required: ['command', 'description'],
    },
  },
  {
    name: 'video_edit',
    description: '用 ffmpeg 处理视频/音频。支持 op：trim 裁剪(time_start/time_end)、concat 合并(inputs 数组)、convert 转码(含 codec)、compress 压缩/改分辨率(width/height/codec)、extract 抽帧(提取第 time 秒的一帧为 png, 需 output 以 .png 结尾)、subtitle 加字幕(subtitle_file)。input 为源文件路径，output 为输出路径(必须在工作区内)。结果写盘并上报产物。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '本次剪辑目的的一句话说明（人读标题）' },
        op: { type: 'string', enum: ['trim', 'concat', 'convert', 'compress', 'extract', 'subtitle'], description: '剪辑操作' },
        input: { type: 'string', description: '单个源文件路径（绝对路径，在工作区内）' },
        inputs: { type: 'array', items: { type: 'string' }, description: 'concat 合并时的多个源文件路径' },
        output: { type: 'string', description: '输出文件路径（绝对路径，必须在工作区内）' },
        time_start: { type: 'string', description: 'trim/截取起始时间，如 00:01:30 或 90' },
        time_end: { type: 'string', description: 'trim/截取结束时间，如 00:02:00' },
        time: { type: 'string', description: 'extract 抽帧的秒/时刻，如 10 或 00:00:10' },
        width: { type: 'number', description: 'compress 目标宽度' },
        height: { type: 'number', description: 'compress 目标高度' },
        codec: { type: 'string', description: 'convert/compress 视频编码，如 libx264 / h264_nvenc' },
        fps: { type: 'number', description: 'compress 目标帧率' },
        subtitle_file: { type: 'string', description: 'subtitle 操作的字幕文件路径(.srt/.ass，工作区内)' },
      },
      required: ['description', 'op', 'output'],
    },
  },
  {
    name: 'generate_image',
    description: '用 AI 生成图片（文生图）。支持 op 为：generate(文生图)。通过 provider 选择生图通道：pollinations(免key默认) / doubao(火山方舟Seedream,需Doubao key) / gemini(谷歌Nano Banana,需Gemini key)。用户可在设置里配置 provider 和对应 API key。输入 prompt(画面描述，越具体越好)，可选 width/height。生成的图为交付产物，对话内显示+右侧预览tab展示。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '本次生图目的的一句话说明（人读标题）' },
        prompt: { type: 'string', description: '画面描述文字（描述主体/场景/风格/光线，尽量具体），如"一只在雪地里奔跑的红狐狸，电影感光影，高清"' },
        width: { type: 'number', description: '宽度(可选，pollinations 用)，默认1024' },
        height: { type: 'number', description: '高度(可选，pollinations 用)，默认1024' },
        provider: { type: 'string', enum: ['pollinations', 'doubao', 'gemini', 'stability', 'replicate', 'openai'], description: '生图通道：pollinations免key / doubao(火山方舟) / gemini(谷歌) / stability(Stability AI) / replicate(Replicate FLUX) / openai(gpt-image)；默认按设置' },
      },
      required: ['description', 'prompt'],
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
  },
  {
    name: 'deep_research',
    description: '深度研究：多轮递归搜索+AI 提炼，生成 3 页以上的详细研究报告（含 Sources 来源列表）。适用于需要全面深入调研的问题（公司分析/产品对比/技术解读/新闻事件背景）。参数 query 为研究主题，breadth 每轮搜索数量(2-6，默认4)，depth 递归深度(1-3，默认2)。耗时 1-3 分钟，请等待完成。',
    category: 'network',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '研究主题（清晰具体，如"对比 OpenAI GPT-5 与 Google Gemini 3 的推理能力"）' },
        breadth: { type: 'number', description: '每轮搜索数量，2-6，默认 4' },
        depth: { type: 'number', description: '递归下钻深度，1-3，默认 2' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ask_question',
    description: '向用户提出结构化问题（带选项或开放输入），挂起等待答复。当任务需要关键决策、缺少必要信息或需要用户确认时使用。',
    category: 'interaction',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问的问题（清晰具体）' },
        options: { type: 'array', items: { type: 'string' }, description: '可选答案列表（2-4 个，可为空表示自由输入）' },
      },
      required: ['question'],
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
    name: 'create_plan',
    description: '创建多步骤执行计划（学 Grok CreatePlan）。任务较复杂（>2 步）时先规划步骤再执行，前端展示计划卡片跟踪进度。',
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '计划标题' },
        description: { type: 'string', description: '计划说明' },
        steps: { type: 'array', items: { type: 'object', properties: { subject: { type: 'string', description: '步骤标题' }, description: { type: 'string' } } }, description: '步骤列表（2-8 步）' },
        session_id: { type: 'string', description: 'Associated session ID' },
      },
      required: ['title', 'steps'],
    },
  },
  {
    name: 'git_status',
    description: '查看工作区 git 状态（已修改/新增/删除文件）。',
    category: 'git',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_diff',
    description: '查看工作区 git 变更内容。staged=true 看已暂存，默认看未暂存。',
    category: 'git',
    parameters: { type: 'object', properties: { staged: { type: 'boolean', description: '是否看已暂存的变更' } } },
  },
  {
    name: 'git_commit',
    description: '提交当前工作区全部变更（git add -A + commit）。提交前先 git_status/git_diff 确认变更内容。',
    category: 'git',
    parameters: { type: 'object', properties: { message: { type: 'string', description: '提交信息（清晰描述变更）' } }, required: ['message'] },
  },
  {
    name: 'computer_use',
    description: '操控用户电脑（截屏/点击/输入/按键/滚动/打开应用）。仅 full 权限可用，调用前需用户确认。action 可选：screenshot(截屏)/click(点击 x,y)/type(输入文本)/key(按键 combo)/scroll(滚动)/move(移动鼠标)/open(打开应用)。',
    category: 'system',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '操作：screenshot / click / type / key / scroll / move / open' },
        args: { type: 'object', description: '参数：click 需 {x,y}；type 需 {text}；key 需 {combo}；scroll 需 {clicks}；move 需 {x,y}；open 需 {name}' },
      },
      required: ['action'],
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
    // get_goal 已迁至 tools/ 目录（ToolDef 注册表，2026-08-25 工具架构轻量包化）——此处不再内联定义，避免工具名重复
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
  // tools/ 目录注册表工具（ToolDef 标准接口，2026-08-25 工具架构轻量包化）
  ...directoryTools.map((t) => ({
    name: t.name,
    description: t.description,
    category: t.category,
    dangerous: t.dangerous || false,
    parameters: t.parameters,
  })),
]

// ============================
// 工具元数据查询
// ============================

export interface SearchResultItem {
  title: string
  url: string
  description?: string
  date?: string
  engine?: string
  score?: number
}

/**
 * 五层搜索链复用入口（deep-research 等内部服务调用）：
 * 包装 toolExecutors.web_search，返回结构化结果而非 JSON 字符串
 */
export async function webSearchChain(
  query: string,
  opts: { count?: number; timeRange?: string; depth?: string } = {},
): Promise<{ engine: string; results: SearchResultItem[]; query: string }> {
  try {
    const out = await toolExecutors.web_search({
      query,
      count: opts.count || 8,
      timeRange: opts.timeRange || '',
      depth: opts.depth || 'basic',
    })
    return JSON.parse(out) as { engine: string; results: SearchResultItem[]; query: string }
  } catch (e) {
    return { engine: 'none', results: [], query }
  }
}

/**
 * DeepSeek 官方原生搜索（web_search_20250305 服务器工具，2026-08-23 验证可用）
 * - Anthropic 兼容端点 https://api.deepseek.com/anthropic/v1/messages，复用同一个 DEEPSEEK key（零新增配置）
 * - DeepSeek 服务器侧执行搜索，返回结构化 web_search_result 条目（title/url/page_age）
 * - 注意：内容为 encrypted_content（加密），拿不到摘要，只能取标题+链接；每次调用=一次完整模型轮次（约 1-2 分钱）
 * - 结果按 URL 去重；未触发搜索（模型没调用工具）或失败返回空
 */
export async function deepseekNativeSearch(query: string, limit = 8): Promise<{ engine: string; results: SearchResultItem[] }> {
  const apiKey = readSetting('apiKey') || process.env.OPENAI_KEY || process.env.DEEPSEEK_API_KEY || ''
  if (!apiKey) return { engine: 'none', results: [] }
  try {
    const resp = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        max_tokens: 512,
        messages: [{ role: 'user', content: `请使用 web_search 工具搜索：${query}` }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      }),
      signal: AbortSignal.timeout(60000),
    })
    if (!resp.ok) return { engine: 'none', results: [] }
    const data = await resp.json() as any
    const results: SearchResultItem[] = []
    const seen = new Set<string>()
    for (const block of data?.content || []) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r.type === 'web_search_result' && r.url && !seen.has(r.url)) {
            seen.add(r.url)
            results.push({ title: r.title || '', url: r.url, description: '', date: r.page_age || '' })
          }
        }
      }
    }
    return { engine: results.length > 0 ? 'deepseek' : 'none', results: results.slice(0, limit) }
  } catch (e) {
    return { engine: 'none', results: [] }
  }
}

export function getToolMeta(name: string): ToolMeta | undefined {
  const def = toolDefinitions.find(t => t.name === name)
  if (!def) return undefined
  return {
    name: def.name,
    category: def.category || 'system',
    dangerous: def.dangerous || false,
  }
}

// ============================================================
// 敏感工具 Auto 授权分类器（2026-08-29 对齐 WorkBuddy PermissionMode.auto）
// ------------------------------------------------------------
// WorkBuddy 的 auto 模式 = AI 分类器：显然安全的安全自动放行，危险动作拒绝，
// 分类器不可用时回退询问。我们这里用**确定性规则分类**（比黑盒分类器更可预测）：
//   - 显然安全的只读命令 / 已知无害操作 → auto allow
//   - 命中危险模式（删除/写系统/高危参数）→ 需要确认（prompt）
//   - 其余未知 → 询问
// 返回 'allow' | 'ask'。
// ------------------------------------------------------------

/** 明显安全的命令前缀（auto 模式直接放行，不弹窗） */
const AUTO_SAFE_PREFIX = [
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'grep', 'find', 'which', 'whoami', 'date',
  'wc', 'stat', 'file', 'printenv', 'env', 'getconf', 'uname', 'true', 'false',
  'git status', 'git log', 'git diff', 'git branch', 'git remote -v', 'git diff --stat',
]

/** 触达危险命令的黑名单（对应 shell_exec 的 BLOCKED + 更高危敏感操作） */
const AUTO_DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-f|-rf)\b/,       // rm -rf / 强删
  /rm\s+-rf\s+(\/|~|\$HOME)/,
  /\bmkfs\b/, /\bdd\s+if=/, /\bshutdown\b/, /\breboot\b/, /\bsudo\b/,
  /\bchmod\s+-R\s+777\s+\//, /\bcron\b/, /\bchown\b/,
  /:[\(\|][:\|]\{/,                           // fork 炸弹
  /\b(curl|wget)\b.*\|\s*(ba)?sh\b/,         // 下载即执行
  /\bmysql\b.*\b(drop|delete from)\b/, /\.ssh\b/, /\.aws\b/, /\.env\b/,
]

/**
 * 分类敏感工具在 auto 模式下的授权决定。
 * @param toolName 工具名（shell_exec / file_delete 等）
 * @param argText 参数字符串（命令内容 / 路径）
 */
export function classifySensitiveTool(toolName: string, argText: string): 'allow' | 'ask' {
  if (!toolName) return 'ask'
  if (toolName === 'file_write') {
    // 写文件在当前工作区通常安全；写敏感系统路径需确认。参数是 JSON（{"path": ...}）
    let path = ''
    try {
      const parsed = JSON.parse(argText)
      if (typeof parsed?.path === 'string') path = parsed.path
    } catch {
      const m = argText.match(/path["']?\s*:\s*["']([^"']+)["']/)
      if (m) path = m[1]
    }
    if (!path) return 'ask'
    // 允许：用户目录（Downloads/Documents/Desktop/工作区）/ /tmp / private/tmp
    if (path.startsWith('/tmp') || path.startsWith('/private/tmp')) return 'allow'
    if (/^\/Users\/\w+\/(Downloads|Documents|Desktop|sandbox|projects|dev|code|workspace)/.test(path)) return 'allow'
    if (path.startsWith('/etc/') || path.startsWith('/System') || path.startsWith('/usr/') || path.startsWith('/bin/')) return 'ask'
    return 'allow' // 其余（如相对路径/工作区内）视为可写
  }
  if (toolName === 'file_delete') return 'ask' // 删除永久敏感，永远确认（对齐老板"删文件才再授权"）

  // shell_exec：先查危险黑名单，再查安全白名单
  const cmd = argText.trim()
  for (const p of AUTO_DANGEROUS_PATTERNS) {
    if (p.test(cmd)) return 'ask'
  }
  // 多行/含管道/含重定向/含后台 → 保守询问
  if (/[\n;|&><]/.test(cmd.replace(/^\s*echo\s+/, ''))) {
    // 允许简单的命令链（&&/;）如果首命令安全，但保守起见含 grep/echo 管道允许
    if (/\|.*(grep|head|tail|wc|sort|aws|jq|sed|find|ls|cat)/.test(cmd)) return 'allow'
    return 'ask'
  }
  // 单命令：安全前缀直接放行
  for (const p of AUTO_SAFE_PREFIX) {
    if (cmd === p || cmd.startsWith(p + ' ')) return 'allow'
  }
  // 纯只读命令（无写参数）
  if (/^(ls|cat|head|tail|grep|find|pwd|date|echo|wc|stat|file|which|git status|git log|git diff)\b/.test(cmd)) return 'allow'
  return 'ask' // 未知命令，询问
}

// 思想：不用把全部工具 schema 塞进每轮请求的 tools 数组。核心调查工具常驻；
// 重型/少用工具（生图/视频/终端/绘图/MCP 资源等）默认不暴露完整 schema，
// 模型需要时先调用 tool_search(名称) 按需加载其定义，随后即可像普通工具一样调用。
// 这样显著压缩每轮 prompt 体积（我们 37 个工具，其中多数带很长 parameters）。
// ------------------------------------------------------------
export const DEFERRED_TOOLS = new Set<string>([
  'generate_image',   // 重型：图片生成参数多、少用
  'video_edit',       // 视频剪辑
  'computer_use',     // 桌面/浏览器控制（重）
  'draw_diagram',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  'skill_view', 'skill_install',  // 技能内容详情/安装（需要时才看）
  'git_commit',        // 带风险的操作，按需暴露
  'memory_store',      // 写入型，非核心
])

/** 常驻 tools 数组 = 全部去掉 DEFERRED */
export const alwaysOnToolDefs = (): ToolDefinition[] =>
  toolDefinitions.filter(t => !DEFERRED_TOOLS.has(t.name))


export function getToolsByCategory(category: string): ToolDefinition[] {
  return toolDefinitions.filter(t => t.category === category)
}

// 行数 diff：对比新旧文本，返回新增/删除行数（WorkBuddy addedLines/deletedLines 同款算法）
function diffLines(oldTxt: string, newTxt: string): { added: number; deleted: number } {
  const a = oldTxt ? oldTxt.split('\n') : []
  const b = newTxt ? newTxt.split('\n') : []
  const counter = new Map<string, number>()
  for (const l of a) counter.set(l, (counter.get(l) || 0) + 1)
  let common = 0
  for (const l of b) {
    const c = counter.get(l) || 0
    if (c > 0) { common++; counter.set(l, c - 1) }
  }
  return { added: Math.max(0, b.length - common), deleted: Math.max(0, a.length - common) }
}

// ============================
// 工具执行入口
// ============================

export interface ToolResultWithMeta extends ToolResult {
  duration?: number
}

/** 互斥工具集（对齐 harness 工具调度器：写类工具=屏障，串行执行防冲突） */
const WRITE_BARRIER_TOOLS = new Set(['file_write', 'multi_edit', 'shell_exec', 'git_commit', 'git_diff', 'create_plan', 'video_edit'])

/**
 * 按互斥规则分组：写类工具各自成组（屏障，串行），相邻读类工具合并成组（并行）
 * 结果顺序与原 toolCalls 一致
 */
function buildBarrierGroups(toolCalls: ToolCall[]): Array<{ calls: Array<{ tc: ToolCall; idx: number }> }> {
  const groups: Array<{ calls: Array<{ tc: ToolCall; idx: number }> }> = []
  let pending: Array<{ tc: ToolCall; idx: number }> = []
  toolCalls.forEach((tc, idx) => {
    if (WRITE_BARRIER_TOOLS.has(tc.function.name)) {
      if (pending.length > 0) { groups.push({ calls: pending }); pending = [] }
      groups.push({ calls: [{ tc, idx }] })  // 写类单独一组 → 串行屏障
    } else {
      pending.push({ tc, idx })
    }
  })
  if (pending.length > 0) groups.push({ calls: pending })
  return groups
}

export async function executeToolCalls(
  toolCalls: ToolCall[],
  ctx?: ToolExecCtx
): Promise<ToolResultWithMeta[]> {
  // 互斥屏障调度（2026-08-23 对齐 harness）：写类工具串行防冲突，读类工具并行提速，结果按原顺序收集
  const results: (ToolResultWithMeta | undefined)[] = new Array(toolCalls.length)

  const runOne = async (tc: ToolCall, idx: number) => {
    // MCP 连接器工具（mcp_<serverId8>_<tool>）→ 动态分发到对应 MCP server
    if (tc.function.name.startsWith('mcp_')) {
      const parts = tc.function.name.split('_')
      const serverId = parts.length >= 3 ? parts[1] : ''
      const toolName = parts.slice(2).join('_')
      let mcpArgs: Record<string, any> = {}
      try { mcpArgs = JSON.parse(tc.function.arguments || '{}') } catch { /* ignore */ }
      if (!serverId) {
        results[idx] = { tool_call_id: tc.id, role: 'tool', content: `❌ 无效的 MCP 工具名: ${tc.function.name}` }
        return
      }
      try {
        const { callMcpTool } = await import('./mcp-manager')
        const content = await callMcpTool(serverId, toolName, mcpArgs)
        results[idx] = { tool_call_id: tc.id, role: 'tool', content }
      } catch (err: any) {
        results[idx] = { tool_call_id: tc.id, role: 'tool', content: `❌ MCP 调用失败: ${err.message}` }
      }
      return
    }
    const executor = toolExecutors[tc.function.name]
    if (!executor) {
      results[idx] = { tool_call_id: tc.id, role: 'tool', content: `Unknown tool: ${tc.function.name}` }
      return
    }

    let args: Record<string, any> = {}
    try {
      args = JSON.parse(tc.function.arguments)
    } catch {
      results[idx] = { tool_call_id: tc.id, role: 'tool', content: `Failed to parse tool arguments: ${tc.function.arguments}` }
      return
    }

    try {
      const startTime = Date.now()
      // 流式输出绑定：统一填当前 toolCallId（工具内部 onOutput('', chunk)）
      const boundCtx = ctx?.onOutput
        ? { ...ctx, onOutput: (_tcId: string, chunk: string) => ctx.onOutput!(tc.id, chunk) }
        : ctx
      const result = await executor(args, boundCtx)
      const duration = (Date.now() - startTime) / 1000
      results[idx] = {
        tool_call_id: tc.id,
        role: 'tool',
        content: result.slice(0, 16000),
        duration,
      }
    } catch (err: any) {
      results[idx] = {
        tool_call_id: tc.id,
        role: 'tool',
        content: `Tool execution error: ${err.message}`,
      }
    }
  }

  // 分组调度：组间串行（写类屏障保证），组内并行
  const groups = buildBarrierGroups(toolCalls)
  for (const group of groups) {
    await Promise.all(group.calls.map(({ tc, idx }) => runOne(tc, idx)))
  }

  return results.filter(Boolean) as ToolResultWithMeta[]
}
