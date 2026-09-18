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
// P1-03 残余迁移前置：9 个共享辅助抽到 tools/shared.ts（纯位置移动，行为不变）
import {
  readSetting, escapeFfPath, scanDirFiles, diffFileSnapshots, resolvePath,
  SENSITIVE_MEMORY_PATTERN, runGit, storeMemory, lintContent, diffLines,
} from '../tools/shared'
// 按需名册与常驻上限下沉到 tools/deferred（tool_search 迁出后需跨文件读取）
import { DEFERRED_TOOLS, MAX_ALWAYS_ON_TOOLS, setToolCatalog } from '../tools/deferred'
export { DEFERRED_TOOLS, MAX_ALWAYS_ON_TOOLS }


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
  /**
   * 索引签名：与 tools/types.ts 的 ToolContext 保持结构等价。
   * 没有它，directoryExecutors（类型是 (args, ctx?: ToolContext) => ...）无法赋给
   * ToolExecutor（ctx?: ToolExecCtx），P1-03 迁移后合并执行器表就会类型报错。
   */
  [key: string]: unknown
}

type ToolExecutor = (args: Record<string, any>, ctx?: ToolExecCtx) => Promise<string>

/**
 * 工具执行器表（name → execute）。
 * 2026-09-18（P1-03 收尾）：全部 42 个工具的执行器都来自 tools/ 注册表，
 * 本对象不再内联任何执行器 —— 加工具 = 在 tools/ 加一个文件并在 registry 登记。
 * 保留本对象是为了对外接口稳定（agent.ts / chat.ts 仍按名字取执行器）。
 */
export const toolExecutors: Record<string, ToolExecutor> = {
  ...directoryExecutors,
}

// ============================
// 搜索结果后处理（web_search / news_search / deep_research 复用）
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

// ============================
// 工具定义（OpenAI Function Calling Schema）
// ============================

export const toolDefinitions: ToolDefinition[] = [
  // tools/ 目录注册表工具（ToolDef 标准接口，2026-08-25 工具架构轻量包化）
  ...directoryTools.map((t) => ({
    name: t.name,
    description: t.description,
    category: t.category,
    dangerous: t.dangerous || false,
    parameters: t.parameters,
  })),
]

// 定义目录注入给 tools/deferred（供 tool_search 惰性读取，避免循环 import）
setToolCatalog(toolDefinitions)

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

// ============================
// 工具两级加载（动态工具集）
// ============================
// 思想：不用把全部工具 schema 塞进每轮请求的 tools 数组 —— 42 个工具的 schema 又长又贵，
// 而且会给模型制造"选择过载"，是选错工具/绕远路的直接原因。
// 核心闭环工具常驻；其余默认不暴露完整 schema，模型先 tool_search 发现，随后即可正常调用。
//
// 常驻契约（2026-09-18 收紧，对齐报告指标「普通任务默认注入工具数 ≤ 12」）：
//   常驻 12 个以内，且必须包含 tool_search —— 否则模型无从发现按需工具。
//   由 validateAlwaysOnContract() 与单测双重看守，超限即失败，不允许静默回归。
//
// 常驻（12）：tool_search / file_read / file_write / multi_edit / shell_exec /
//            web_search / web_fetch / deep_research / create_plan /
//            task_create / task_update / ask_user
// 取舍依据：本产品核心价值是「完成任务 → 交付结果 → 可控安全 → 可恢复 → 扩展」，
//   故工作区读写+执行（file_*/shell_exec）、信息获取（web_*/deep_research）、
//   计划与进度（create_plan/task_*）、澄清（ask_user）常驻；
//   git/技能/记忆/终端/生图/浏览器/桌面控制等属"用到才需要的扩展能力"，按需加载。

/**
 * 常驻工具数上限（报告指标：普通任务默认注入工具数 ≤ 12）。
 * 改 DEFERRED_TOOLS 时若把常驻数顶超，validateAlwaysOnContract 会直接报错。
 */

/** 常驻 tools 数组 = 全部去掉 DEFERRED */
export const alwaysOnToolDefs = (): ToolDefinition[] =>
  toolDefinitions.filter(t => !DEFERRED_TOOLS.has(t.name))

/**
 * 常驻契约校验：① 常驻数 ≤ MAX_ALWAYS_ON_TOOLS ② tool_search 必须常驻
 * ③ 按需工具必须真实存在（防止 DEFERRED 里写了已删除的工具名，永远搜不到）
 * 由 scripts/validate-tools.ts 与单测调用，把"工具膨胀"变成 CI 可拦的度量。
 */
export function validateAlwaysOnContract(): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  const on = alwaysOnToolDefs()
  if (on.length > MAX_ALWAYS_ON_TOOLS) {
    errors.push(`常驻工具 ${on.length} 个，超过上限 ${MAX_ALWAYS_ON_TOOLS}（报告指标 ≤12）；请把新工具登记进 DEFERRED_TOOLS 或复核取舍`)
  }
  if (!on.some((t) => t.name === 'tool_search')) {
    errors.push('tool_search 必须常驻 —— 否则模型无从发现按需工具')
  }
  const known = new Set(toolDefinitions.map((t) => t.name))
  for (const n of DEFERRED_TOOLS) {
    if (!known.has(n)) errors.push(`DEFERRED_TOOLS 中的 "${n}" 不是已注册工具（拼写错误或工具已删除）`)
  }
  if (!DEFERRED_TOOLS.has('tool_search') && on.length === 0) {
    errors.push('toolDefinitions 为空，工具注册异常')
  }
  return { ok: errors.length === 0, errors }
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
