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
// 结构化进度类型（G5/I13，2026-09-24）：工具经 ctx.onProgress 上报，前端不再解析中文文案
import type { ToolProgress } from '../tools/types'
export { DEFERRED_TOOLS, MAX_ALWAYS_ON_TOOLS }


// ============================
// 类型定义
// ============================

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, any>
  category?: 'memory' | 'file' | 'network' | 'system' | 'interaction' | 'git' | 'terminal'
  /** 见 tools/types.ts 的 ToolDef.requiresApproval —— 审批需求的唯一来源（I2） */
  requiresApproval?: boolean
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
  /** 工具流式输出回调：命令执行分片实时推送（主流实现 streamOutput 同款） */
  onOutput?: (toolCallId: string, chunk: string) => void
  /**
   * 工具执行进度回调（结构化，G5/I13）。
   * 与 `onOutput` 同构：工具内传 `''`，真实 toolCallId 由下面的 `boundCtx` 注入。
   */
  onProgress?: (toolCallId: string, progress: ToolProgress) => void
  /** 实时预览回调：写入 .html 文件时触发（前端右侧边栏实时渲染） */
  onPreview?: (path: string, content: string) => void
  /** 画图回调：AI 生成 SVG 图表时触发（前端聊天内直接渲染） */
  onDiagram?: (title: string, svg: string) => void
  /** 画图流式块回调：SVG 按标签边界切块实时推送（主流实现同款"先出画板再逐框绘制"——SVG 元素闭合即被浏览器绘制） */
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
    requiresApproval: t.requiresApproval || false,
    parameters: t.parameters,
  })),
]

// 定义目录注入给 tools/deferred（供 tool_search 惰性读取，避免循环 import）
setToolCatalog(toolDefinitions)

// ============================
// 敏感（需审批）工具集合 —— I2，2026-09-24
// ============================
/**
 * **由 ToolDef.requiresApproval 派生，不手写**。
 *
 * 这就是 I2 的修复本体：此前 `agent.ts` 里内联硬编码了一份
 * `new Set(['shell_exec','file_write','file_delete','memory_consolidate'])`，
 * 和工具定义里的声明**没有任何机械关联**，于是 `computer_use` / `skill_install` /
 * `multi_edit` 声明了危险却根本不走审批。
 *
 * ⚠️ 不要在别处再写一份名单。`scripts/validate-tools.ts` 有断言兜住这件事
 * （跑 `pnpm --filter @supercrzy/server validate:tools`，也在 `pnpm verify` 里）。
 */
export const SENSITIVE_TOOLS: ReadonlySet<string> = new Set(
  toolDefinitions.filter((d) => d.requiresApproval).map((d) => d.name),
)

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

// ============================================================
// 敏感工具 Auto 授权分类器（2026-08-29 对齐主流实现 PermissionMode.auto）
// ------------------------------------------------------------
// 主流实现 的 auto 模式 = AI 分类器：显然安全的安全自动放行，危险动作拒绝，
// 分类器不可用时回退询问。我们这里用**确定性规则分类**（比黑盒分类器更可预测）：
//   - 显然安全的只读命令 / 已知无害操作 → auto allow
//   - 命中危险模式（删除/写系统/高危参数）→ 需要确认（prompt）
//   - 其余未知 → 询问
// 返回 'allow' | 'ask' | 'block'。
//
// 三值语义（2026-09-24 扩为三值，对齐"除删除外全放行、危险命令仍拦"）：
//   allow —— 显然安全，直接放行
//   ask   —— 需要授权，但「本会话全部允许」/ auto 档可以放行
//   block —— **不可逆 / 高危**：任何档位、任何会话白名单都**不**放行
//
// ⚠️ 旧实现把整段 `arguments` JSON 当命令来跑正则，于是
//    `{"command":"rm -rf /x"}` 里 `rm` 前面是 `"` 而不是分隔符，**任何危险模式都匹配不上**——
//    等于 auto 档的危险闸门形同虚设。现在统一先用 `extractShellCommand` 取出真正的命令文本。
// ------------------------------------------------------------

/** ★ 不可逆 / 高危：任何档位与白名单都不放行（磁盘、凭据外传、强推…）
 *  ⚠️ rm 不在这里：2026-09-25 老板裁决"先优化再打包"，rm 移到**段级分级**（classifyRmSegment）——
 *  模型清理自己写的临时文件（rm /tmp/x 或 rm scripts/probe.mts）是最高频弹窗源，
 *  无递归 + 目标全在 /tmp 或工作区内 → 降 allow；带 -r / 工作区外 → 仍 block。 */
const IRREVERSIBLE_PATTERNS: RegExp[] = [
  /\bmkfs\b/, /\bdd\s+if=/, /\bdiskutil\s+erase\b/, /\bnewfs\b/,
  /\bshutdown\b/, /\breboot\b/, /\bhalt\b/,
  /:[\(\|][:\|]\{/,                            // fork 炸弹
  /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/,      // 下载即执行
  /\bbase64\b[^|]*\|\s*(ba|z)?sh\b/,
  /\b(mysql|psql|sqlite3)\b[^\n]*\b(drop|truncate|delete\s+from)\b/i,
  /\.ssh\b|\.aws\b|\.env\b|\.npmrc\b|id_rsa\b|\/etc\/shadow\b/,   // 凭据 / 私钥（"用密码连服务器"类）
  /\bchmod\s+(-R\s+)?777\s+\//, /\bchown\s+-R\b/,
  /\bgit\s+push\b[^\n]*--force/, /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\b[^\n]*-[fFdDxX]+/,
  />\s*\/dev\/(sd|disk|rdisk)/,
]

// ---- rm 段级分级（2026-09-25，老板"先优化"裁决）----
/** 审批用工作区根（由 agent 初始化时注入；空 = 未注入，相对路径仍视为安全=相对 workspace cwd） */
let approvalWorkspaceRoot = ''
export function setApprovalWorkspaceRoot(root: string | undefined | null) {
  approvalWorkspaceRoot = (root || '').replace(/\/+$/, '')
}

/** rm 目标是否"可恢复安全"：/tmp、相对路径（相对 workspace cwd）、workspace 内绝对路径 */
function isWorkspaceSafePath(target: string): boolean {
  const raw = target.replace(/^['"]|['"]$/g, '').trim()
  if (!raw) return false
  if (raw.startsWith('/tmp/') || raw === '/tmp' || raw.startsWith('/private/tmp/')) return true
  if (!raw.startsWith('/')) return true // 相对路径：executor 总是 cd workspace 执行
  if (approvalWorkspaceRoot && raw.startsWith(approvalWorkspaceRoot + '/')) return true
  return false
}

/**
 * 单段 rm 分级：`null` = 本段不是 rm；`block` = 提权/递归删除或工作区外目标；`allow` = 非递归且目标全安全。
 * 模型高频模式"写临时脚本 → rm 清理"由此不再弹窗（auto 档），带 -r 或越界仍然必弹。
 * sudo rm（提权删除）恒 block。
 */
function classifyRmSegment(seg: string): 'block' | 'allow' | null {
  const bare = seg.replace(/^(\w+=\S*\s+)+/, '').replace(/^\s*(do|then)\s+/, '').trim()
  const sudo = /^sudo\s+/.test(bare)
  const rest = sudo ? bare.slice(5).trimStart() : bare
  if (!/^rm(\s|$)/.test(rest)) return null
  if (sudo) return 'block' // 提权删除：任何情况都拦
  const tokens = rest.split(/\s+/).slice(1)
  const targets: string[] = []
  let recursive = false
  for (const t of tokens) {
    if (t === '--') continue
    if (t.startsWith('--')) {
      if (/recursive/i.test(t)) recursive = true
      continue
    }
    if (t.startsWith('-')) {
      if (/r/i.test(t)) recursive = true // -r -rf -fr …（-i/-f/-v 无害）
      continue
    }
    targets.push(t)
  }
  if (recursive) return 'block'
  if (targets.length === 0) return 'block' // 语法残缺（如被引号切碎），保守拦
  return targets.every(isWorkspaceSafePath) ? 'allow' : 'block'
}

/** 可恢复但值得看一眼：auto 档询问，会话白名单后放行
 *  （rmdir 只能删空目录，已在 AUTO_SAFE_PREFIX，2026-09-25 从这里移除避免自相矛盾） */
const SUSPICIOUS_PATTERNS: RegExp[] = [
  /\bsudo\b/, /\b(crontab|cron)\b/, /\bchmod\b/, /\bchown\b/, /\bkill(all)?\b/,
  /\bsandbox-exec\b/, /\b(launchctl|systemctl)\b/, /\bscp\b|\brsync\b/, /\bcrontab\b/,
]

/** 明显安全的命令前缀（auto 档直接放行，不弹窗） */
const AUTO_SAFE_PREFIX = [
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'grep', 'find', 'which', 'whoami', 'date',
  'wc', 'stat', 'file', 'printenv', 'env', 'getconf', 'uname', 'true', 'false',
  'git status', 'git log', 'git diff', 'git branch', 'git remote -v', 'git diff --stat',
  // 2026-09-24 扩充：真实会话里 9/13 条被误问的命令是这些（构建/测试/脚本/提交），
  // 对齐主流实现 command-risk.ts —— 构建、管道、重定向、&& 链一律 low，不拦。
  'npm', 'pnpm', 'npx', 'yarn', 'bun', 'node', 'deno', 'tsc', 'tsx',
  'vitest', 'jest', 'pytest', 'python', 'python3', 'pip', 'pip3', 'uv',
  'make', 'cargo', 'go', 'rustc', 'gradle', 'mvn', 'javac',
  'mkdir', 'touch', 'cp', 'mv', 'ln', 'rmdir', 'tee',
  'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'xargs', 'jq', 'comm', 'diff', 'split',
  'git add', 'git commit', 'git checkout', 'git switch', 'git stash', 'git fetch',
  'git pull', 'git merge', 'git rebase', 'git tag', 'git show', 'git blame',
  'git ls-files', 'git rev-parse', 'git describe', 'git worktree',
  'sqlite3', 'curl', 'wget', 'open', 'pbcopy', 'pbpaste', 'defaults', 'plutil',
  'sw_vers', 'df', 'du', 'ps', 'lsof', 'sleep', 'printf', 'test', 'basename', 'dirname',
  'realpath', 'md5', 'shasum', 'md5sum', 'mdfind', 'tree', 'zip', 'unzip', 'tar',
  // 2026-09-25 补：真实会话日志里被误问的（pgrep 查进程 / seq 生成序列）
  'pgrep', 'seq',
  // 2026-09-25 二次补：cd 前缀（模型几乎所有命令都 cd 进子包）；for/while/if 是 shell
  // 语法关键字，其体内的每个子段都会被独立判定（rm/危险模式段级仍拦），关键字本身无副作用
  'cd', 'for', 'while', 'until', 'if',
]

/** 纯重定向 / 赋值片段（`2>&1`、`> /dev/null`、`FOO=bar`）——安全 */
const REDIRECT_ONLY_RE = /^([0-9]?>>?\s*\S+|&>+\s*\S+|\w+=\S*|\|[&]?)$/

/**
 * 从一个 shell 工具调用参数里取出**真正的命令文本**。
 * 参数是 JSON（`{command,description,timeout}`）时只认已知键；解析失败才当成裸命令串。
 * 解析成功但没有命令键 → 返回 ''（未知 → 交给上层按 ask 处理），**绝不把整段 JSON 当命令**。
 */
export function extractShellCommand(argText: string): string {
  const raw = String(argText ?? '').trim()
  if (!raw) return ''
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      for (const k of ['command', 'cmd', 'script', 'commandLine']) {
        if (typeof parsed?.[k] === 'string') return parsed[k]
      }
      return ''
    } catch {
      return '' // 看着像 JSON 但解析不了：不敢当命令，交给上层保守处理
    }
  }
  return raw
}

/**
 * 按 shell 分隔符切段：`\n` `;` `&&` `||` `|`。
 * 2026-09-25 重写（引号 + heredoc 感知）：旧实现裸 split 把引号内的 `;`/`|`/换行也切——
 * 实测模型高频模式全部误伤：`node -e "a(); b()"`（引号内分号）、多行 `python3 -c "\n…\n"`、
 * `python3 - <<EOF`（heredoc 体每行被当独立命令）→ 15 条真实命令 8 条被误判 ask。
 * 现在：引号内不切；heredoc 体整体依附宿主段（体随宿主命令前缀定级）。
 */
function splitShellSegments(cmd: string): string[] {
  const segs: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let heredocTag: string | null = null
  const push = () => { const t = cur.trim(); if (t) segs.push(t); cur = '' }

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!
    // heredoc 体：原样吞入，直到独立成行的结束标记
    if (heredocTag !== null) {
      cur += ch
      if (ch === '\n' || i === cmd.length - 1) {
        const lastLine = cur.split('\n').pop()!.trim()
        if (lastLine === heredocTag) heredocTag = null
      }
      continue
    }
    if (quote) {
      cur += ch
      if (quote === '"' && ch === '\\') { cur += cmd[++i] ?? ''; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue }
    if (ch === '\\') { cur += ch + (cmd[++i] ?? ''); continue }
    // heredoc 开始（无引号状态）：`<<[-] tag`，tag 允许带引号包裹
    if (ch === '<' && cmd[i + 1] === '<') {
      let j = i + 2
      let tag = ''
      while (j < cmd.length && /[-\s'"]/.test(cmd[j]!)) j++
      while (j < cmd.length && /\w/.test(cmd[j]!)) tag += cmd[j++]!
      if (tag) {
        heredocTag = tag
        cur += cmd.slice(i, j)
        i = j - 1
        continue
      }
    }
    // 分隔符：`\n` `;` `|`（含 `||`）切；`&` **只在 `&&` 时切**——单个 `&` 是 `2>&1` 重定向/后台符，
    // 旧正则也只切 `&&`，这里若把单 `&` 切了会把 `npm run build > x.log 2>&1` 切碎（实测回归）。
    if (ch === '\n' || ch === ';' || ch === '|' || (ch === '&' && cmd[i + 1] === '&')) { push(); if (ch === '&' || (ch === '|' && cmd[i + 1] === '|')) i++; continue }
    cur += ch
  }
  push()
  return segs
}

/**
 * 命令分类（**按段判定**，不再"整条命令含管道就一律询问"）。
 *
 * 旧规则 `/[\n;|&><]/` 命中即 ask —— 于是 `npm run build`、`git commit`、
 * `node x.mjs | head`、`cmd > log` 全被拦，实测 13 条真实命令 9 条询问。
 * 现在：先整条扫不可逆模式（含跨段组合如 `curl … | sh`），再逐段判安全/可疑。
 */
export function classifyShellCommand(command: string): 'allow' | 'ask' | 'block' {
  const cmd = String(command || '').trim()
  if (!cmd) return 'ask'
  for (const p of IRREVERSIBLE_PATTERNS) if (p.test(cmd)) return 'block'

  let worst: 'allow' | 'ask' = 'allow'
  for (const seg of splitShellSegments(cmd)) {
    if (IRREVERSIBLE_PATTERNS.some((p) => p.test(seg))) return 'block'
    // rm 段级分级（2026-09-25）：非递归 + /tmp 或工作区内 → allow；递归/越界 → block
    const rmVerdict = classifyRmSegment(seg)
    if (rmVerdict === 'block') return 'block'
    if (rmVerdict === 'allow') continue
    // 明确可疑（sudo/chmod/chown/kill/launchctl/rsync…）→ 必须问
    if (SUSPICIOUS_PATTERNS.some((p) => p.test(seg))) { worst = 'ask'; continue }
    // 🔴 2026-10-18 决策（老板：「1+3」）：**未知命令默认放行，不再询问**。
    //
    //   改前：`if (!isSafeSegment(seg)) worst = 'ask'` —— 凡不在 AUTO_SAFE_PREFIX 白名单里的
    //         命令一律弹框。实测这导致 `python3 -m ...`、`git cherry-pick`、`docker ps` 之类
    //         无害命令每次都问，用户看到"一闪而过的授权框"。
    //   对标 WorkBuddy（/cli/dist/codebuddy-lite-wb.mjs:1163 原文）：
    //         `needsApproval.some(t => "unknown" !== t.level)`
    //         —— 它把 level==="unknown" **排除**在触发条件之外，即未知 = 放行。
    //
    //   安全不倒退的理由：真正危险的东西在**上面两步已经拦死**，与本白名单无关 ——
    //     ① IRREVERSIBLE_PATTERNS（含 `curl … | sh` 跨段组合）→ block
    //     ② classifyRmSegment（递归 rm / 越界 rm）→ block
    //     ③ SUSPICIOUS_PATTERNS（提权、改权限、改所有者、杀进程、装守护进程）→ ask
    //   白名单从此只是"已知安全"的**快捷说明**，不再是"未知即危险"的隐式规则。
  }
  return worst
}

function isSafeSegment(seg: string): boolean {
  const s = seg.replace(/^[()]+|[()]+$/g, '').trim()
  if (!s) return true
  if (REDIRECT_ONLY_RE.test(s)) return true
  // 剥掉前置环境变量赋值：`NODE_ENV=test npm test`
  let bare = s.replace(/^(\w+=\S*\s+)+/, '')
  // 剥 shell 语法关键字前缀与纯关键字残段（for/while 切段产物）：`do echo $x`、`done`、`then …`
  bare = bare.replace(/^(do|then|else)\s+/, '')
  if (/^(done|fi|esac)$/.test(bare)) return true
  if (REDIRECT_ONLY_RE.test(bare)) return true
  for (const p of AUTO_SAFE_PREFIX) {
    if (bare === p || bare.startsWith(p + ' ')) return true
  }
  return false
}

/**
 * 分类敏感工具在授权判定中的决定。消费方：`permission.ts` 的 `decideToolApproval`。
 * @param toolName 工具名（shell_exec / file_delete 等）
 * @param argText 参数字符串（shell_exec 是含 command 的 JSON）
 */
export function classifySensitiveTool(toolName: string, argText: string): 'allow' | 'ask' | 'block' {
  if (!toolName) return 'ask'

  if (toolName === 'file_write' || toolName === 'multi_edit') {
    // 写文件在当前工作区通常安全；写敏感系统路径需确认。
    // multi_edit 参数名是 file_path 而不是 path，这里一并认。
    const path = extractTargetPath(argText)
    if (!path) return 'ask'
    if (path.startsWith('/tmp') || path.startsWith('/private/tmp')) return 'allow'
    if (/^\/Users\/\w+\/(Downloads|Documents|Desktop|sandbox|projects|dev|code|workspace)/.test(path)) return 'allow'
    // 系统路径写入不可逆（覆盖 /etc、/usr/bin）→ block，不因白名单放行
    if (path.startsWith('/etc/') || path.startsWith('/System') || path.startsWith('/usr/') || path.startsWith('/bin/') || path.startsWith('/sbin/')) return 'block'
    return 'allow' // 其余（相对路径 / 工作区内）视为可写
  }

  if (toolName === 'file_delete') return 'block'   // 删除永不可逆：任何档位/白名单都拦（老板"除删除外全放行"）
  if (toolName === 'skill_install') return 'block' // 装的是可执行代码，对齐主流实现恒问集合
  if (toolName === 'computer_use') return 'block'  // 操作本机（操作本机类工具恒问）

  if (toolName === 'shell_exec') return classifyShellCommand(extractShellCommand(argText))

  return 'ask' // 未知敏感工具：保守询问（但白名单可放行）
}


/** 从工具参数 JSON 里取目标路径。认 `path` 与 `file_path` 两种键名（multi_edit 用后者）。 */
function extractTargetPath(argText: string): string {
  try {
    const parsed = JSON.parse(argText)
    for (const k of ['path', 'file_path']) {
      if (typeof parsed?.[k] === 'string') return parsed[k]
    }
  } catch {
    const m = argText.match(/(?:file_)?path["']?\s*:\s*["']([^"']+)["']/)
    if (m) return m[1]
  }
  return ''
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
      // 流式输出 / 结构化进度绑定：统一填当前 toolCallId（工具内部传 '' 由这里补真实 id）
      // ⚠️ 两个绑定必须各自独立判断：只绑 onOutput 会让 onProgress 漏掉 toolCallId（反之亦然）
      let boundCtx: ToolExecCtx | undefined = ctx
      if (ctx?.onOutput) boundCtx = { ...(boundCtx || {}), onOutput: (_tcId: string, chunk: string) => ctx.onOutput!(tc.id, chunk) }
      if (ctx?.onProgress) boundCtx = { ...(boundCtx || {}), onProgress: (_tcId: string, p: ToolProgress) => ctx.onProgress!(tc.id, p) }
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
