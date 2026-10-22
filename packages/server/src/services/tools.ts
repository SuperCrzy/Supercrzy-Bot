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
  // 2026-10-22：**系统路径写入**必须与 file_write 同级 block。
  //   此前只有 `> /dev/sd*` 与凭据类被拦，`echo x > /etc/hosts` 判的是 `ask`（中风险）；
  //   把弹窗阈值抬到 block 之后，这类命令就成了"悄悄覆盖系统文件"的口子 —— 而用 shell 覆盖
  //   比 file_write 更容易撞上。两条：① 重定向目标是系统路径 ② cp/mv/ln/install/tee/dd 搬到系统路径。
  />\s*\/(?:etc|System|usr|bin|sbin|private\/etc)\//,
  /\b(?:cp|mv|ln|install|tee|dd|rsync)\b[^\n;|&]*[=\s]\/(?:etc|System|usr|bin|sbin|private\/etc)\/\S*\s*$/,

  // 2026-10-22：删除的"换皮"写法。此前只认命令名 `rm` 开头的段，于是下面这些判 allow：
  //   find . -delete            —— 另一种删除，一个文件都不剩
  //   find . -name '*.ts' -exec rm {} \;  —— 遍历删除
  //   ls | xargs rm             —— xargs 转手删除
  // 这三类都没有"可恢复"的余地，与 rm -rf 同级。
  /\bfind\b[^\n;|&]*\s-delete\b/,
  /\bfind\b[^\n;|&]*\s-exec(dir)?\s+(\S*\/)?rm\b/,
  /\bxargs\b[^\n;|&]*\s(\S*\/)?rm\b/,
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
  // 2026-10-22：命令名归一。用完整路径调 rm（`/bin/rm -rf ~/x`）此前不匹配 `^rm`，
  // 直接漏成 allow —— 这是最容易被模型"顺手"写出来的绕过形式（Tab 补全就是全路径）。
  // macOS 上 `\rm` 还用来绕过 alias，一并归一。
  const normalized = rest
    .replace(/^(?:[~.\w-]*\/)+rm(?=\s|$)/, 'rm')
    .replace(/^\\rm(?=\s|$)/, 'rm')
  if (!/^rm(\s|$)/.test(normalized)) return null
  if (sudo) return 'block' // 提权删除：任何情况都拦
  const tokens = normalized.split(/\s+/).slice(1)
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
 *  （rmdir 只能删空目录，2026-09-25 从这里移除避免自相矛盾） */
const SUSPICIOUS_PATTERNS: RegExp[] = [
  /\bsudo\b/, /\b(crontab|cron)\b/, /\bchmod\b/, /\bchown\b/, /\bkill(all)?\b/,
  /\bsandbox-exec\b/, /\b(launchctl|systemctl)\b/, /\bscp\b|\brsync\b/, /\bcrontab\b/,
]

/**
 * 命令段的"写意图"识别（2026-10-22，对标 WorkBuddy 的 `classifyCommandOps`）。
 *
 * 起因：`classifyShellCommand` 对未知段一律 allow（2026-10-18 裁决），而写文件的命令
 * （`echo x > src/a.ts`、`sed -i`、`tee out.log`）恰好都属于"未知"
 * ⇒ **静默绕过 `file_write` 的 approval**，即"改项目文件的命令不用问，用工具改才问"。
 *
 * 对照 WorkBuddy（`cli.mjs@4884514` 反查原文），它把命令按静态名表分成四类：
 *   delete: rm/rmdir/unlink/del/erase/rd
 *   write : `>`/`>>` 重定向 + mkdir/touch/cp/mv/tee/install/sed/copy/set-content/out-file
 *   read  : cat/ls/grep/find/head/tail/less/more/stat/type/dir
 *   access: 其余
 * 然后 write 走 needsApproval 策略。
 *
 * 我们只补**改内容**那一类（`delete` 已有 `classifyRmSegment`，`read` 无需拦）：
 * `mkdir/touch/cp/mv/ln` 这类结构性操作**不纳入**——构建链路里太常见，一拦就退回
 * "步步弹框"（老板 2026-10-22 刚投诉的那个问题）。
 * 日志重定向（`> /tmp/x.log`、`2>&1`、`> /dev/null`）必须继续放行，否则
 * `pnpm test > /tmp/x.log 2>&1` 又要弹。
 */

/** 只写内容的命令（`head 锚定`：`pnpm install` / `npm install` 不算写） */
const CONTENT_WRITE_HEAD_RE = /^(?:sudo\s+)?(tee|truncate|install|set-content|out-file)(?:\s|$)/

/** 原地改文件：`sed -i`、`sed -i.bak`、`sed -n -i` */
const INPLACE_SED_RE = /(?:^|\s)sed\s+[^|;]*?-[a-zA-Z]*i(?:[.\s]|$)/

/** 目标路径是否属于"随手写"（临时/黑洞）——这类重定向不算改文件 */
function isScratchPath(p: string): boolean {
  const s = p.trim().replace(/^['"]|['"]$/g, '')
  if (!s) return true
  if (s === '/dev/null' || s === '/dev/stdout' || s === '/dev/stderr') return true
  if (/^\d+$/.test(s) || /^&\d+$/.test(s)) return true // 2>&1 里的 &1
  return s === '/tmp' || s.startsWith('/tmp/') || s === '/private/tmp' || s.startsWith('/private/tmp/')
}

/**
 * 扫出段里所有重定向目标（`>` / `>>` / `&>`）。
 *
 * 不能用正则直接扫：`python3 -c "if a > b: …"`、`grep ">" f`、`node -e 'x=>y'` 里的
 * `>` 都在引号内，正则会误判成写文件（heredoc 同理，见 `stripHeredocBody`）。
 * 这里走一个引号感知的小扫描器；`2>&1` 这类目标以 `&` 开头 → 读不出目标 → 跳过。
 */
function findRedirectTargets(seg: string): string[] {
  const out: string[] = []
  let quote: '"' | "'" | null = null
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]!
    if (quote) { if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch !== '>') continue
    let j = i + 1
    if (seg[j] === '>') j++ // `>>`
    while (j < seg.length && /\s/.test(seg[j]!)) j++
    let target = ''
    if (seg[j] === '"' || seg[j] === "'") {
      const tq = seg[j]!
      j++
      while (j < seg.length && seg[j] !== tq) target += seg[j++]!
      j++
    } else {
      while (j < seg.length && !/[\s;&|)]/.test(seg[j]!)) target += seg[j++]!
    }
    if (target) out.push(target)
    i = j - 1
  }
  return out
}

/**
 * 去掉 heredoc 体，只留宿主命令行。
 * 模型高频写文件的手法就是 `cat > f <<'EOF' … EOF` / `python3 - <<EOF … EOF`；
 * 体里的 `if a > b:` 会被当成写重定向（实测误报），故先切掉。
 */
function stripHeredocBody(seg: string): string {
  const start = seg.search(/<<-?\s*['"]?\w/)
  if (start < 0) return seg
  const tag = seg.slice(start).match(/<<-?\s*['"]?(\w+)/)?.[1]
  const nl = seg.indexOf('\n', start)
  if (!tag || nl < 0) return seg.slice(0, nl < 0 ? seg.length : nl)
  const head = seg.slice(0, nl)
  const lines = seg.slice(nl + 1).split('\n')
  const end = lines.findIndex((l) => l.trim() === tag)
  const tail = end >= 0 ? lines.slice(end + 1).join('\n') : ''
  return tail ? `${head}\n${tail}` : head
}

/** 段是否"会改文件内容"。true 表示需要确认（ask）。 */
function isContentWriteSegment(seg: string): boolean {
  const bare = stripHeredocBody(seg)
    .replace(/^(\w+=\S*\s+)+/, '')
    .replace(/^\s*(do|then|else)\s+/, '')
    .trim()
  if (!bare) return false
  // ① 重定向写真实文件
  if (findRedirectTargets(bare).some((t) => !isScratchPath(t))) return true
  // ② 原地改文件
  if (INPLACE_SED_RE.test(bare)) return true
  // ③ 只写内容的命令；参数全是临时路径时放行（`tee /tmp/x.log`）
  const m = bare.match(CONTENT_WRITE_HEAD_RE)
  if (m) {
    const args = bare.slice(m[0].length).split(/\s+/).filter((a) => a && !a.startsWith('-'))
    if (args.length === 0) return false
    return !args.every(isScratchPath)
  }
  return false
}

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
  return judgeCommand(cmd, 2)
}

/**
 * 把 `sh -c '…'` / `bash -c "…"` / `zsh -lc '…'` 的内层命令取出来（只拆一层）。
 *
 * 2026-10-22：这是最省事的一条绕过 —— `sh -c 'rm -rf ~/x'` 整段的命令名是 `sh`，
 * 判「未知 → allow」，而内层是真删除。模型也确实爱这么写（拼管道、设环境变量时）。
 */
function unwrapShellC(seg: string): string | null {
  const m = seg.match(/^\s*(?:(?:[~.\w-]*\/)+)?(?:ba|z|da|k|fi)?sh\s+-[a-zA-Z]*c\s+([\s\S]+)$/)
  if (!m) return null
  let inner = m[1].trim()
  const q = inner[0]
  if ((q === "'" || q === '"') && inner.length > 1 && inner[inner.length - 1] === q) {
    inner = inner.slice(1, -1)
  }
  return inner.trim() || null
}

/** 单段判定（含 shell 包装展开）；depth = 还能往下展开几层 */
function judgeSegment(seg: string, depth: number): 'allow' | 'ask' | 'block' {
  if (IRREVERSIBLE_PATTERNS.some((p) => p.test(seg))) return 'block'
  // rm 段级分级（2026-09-25）：非递归 + /tmp 或工作区内 → allow；递归/越界 → block
  const rmVerdict = classifyRmSegment(seg)
  if (rmVerdict === 'block') return 'block'
  if (rmVerdict === 'allow') return 'allow'
  // 包了一层 shell 的写法：内层更坏就取内层（内层清白不代表整段清白，也不额外加严）
  if (depth > 0) {
    const inner = unwrapShellC(seg)
    if (inner && inner !== seg) {
      const innerVerdict = judgeCommand(inner, depth - 1)
      if (innerVerdict !== 'allow') return innerVerdict
    }
  }
  // 明确可疑（sudo/chmod/chown/kill/launchctl/rsync…）→ 必须问
  if (SUSPICIOUS_PATTERNS.some((p) => p.test(seg))) return 'ask'
  // 改文件内容的段（`> 真实路径`、`sed -i`、`tee`）→ 问。
  // 必须排在「未知 → allow」之前：否则这条命令绕过 file_write 的审批（2026-10-22）
  if (isContentWriteSegment(seg)) return 'ask'
  return 'allow'
}

/** 整条命令判定：任一段 block 即 block；否则有 ask 就 ask；全清白才 allow */
function judgeCommand(cmd: string, depth: number): 'allow' | 'ask' | 'block' {
  for (const p of IRREVERSIBLE_PATTERNS) if (p.test(cmd)) return 'block'
  let worst: 'allow' | 'ask' = 'allow'
  for (const seg of splitShellSegments(cmd)) {
    const v = judgeSegment(seg, depth)
    if (v === 'block') return 'block'
    if (v === 'ask') worst = 'ask'
    // 🔴 2026-10-18 决策（老板：「1+3」）：**未知命令默认放行，不再询问**。
    //
    //   改前：`if (!isSafeSegment(seg)) worst = 'ask'` —— 凡不在 AUTO_SAFE_PREFIX 白名单里的
    //         命令一律弹框。实测这导致 `python3 -m ...`、`git cherry-pick`、`docker ps` 之类
    //         无害命令每次都问，用户看到"一闪而过的授权框"。
    //   对标 WorkBuddy（/cli/dist/codebuddy-lite-wb.mjs:1163 原文）：
    //         `needsApproval.some(t => "unknown" !== t.level)`
    //         —— 它把 level==="unknown" **排除**在触发条件之外，即未知 = 放行。
    //
    //   安全不倒退的理由：真正危险的东西在**上面几步已经拦死**，与白名单无关 ——
    //     ① IRREVERSIBLE_PATTERNS（含 `curl … | sh` 跨段组合）→ block
    //     ② classifyRmSegment（递归 rm / 越界 rm）→ block
    //     ③ SUSPICIOUS_PATTERNS（提权、改权限、改所有者、杀进程、装守护进程）→ ask
    //     ④ isContentWriteSegment（写项目文件内容）→ ask
    //   ⚠️ 那份 AUTO_SAFE_PREFIX 白名单（23 行、90 余条前缀）随本条裁决一起**删除**：它已无引用，
    //      留着只会让人误以为"未知=危险"还生效（2026-10-22 复盘：白名单变死代码后，
    //      写文件类命令就成了审批盲区，见 ④）。
  }
  return worst
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
  // 2026-10-20：手机端「手」同理 —— 会真的点在用户手机界面上（可能误触拨号/转账），
  // 归入"操作本机类"，首次必问；会话内显式允许后不再逐次打断。
  if (toolName === 'android_action') return 'block'

  if (toolName === 'shell_exec') return classifyShellCommand(extractShellCommand(argText))

  // ---- 持久终端（2026-10-22 P0-1）----
  // 病根：`terminal_send` 会往真终端里打字并回车，**它就是执行命令**，但这条路径
  // 既不在 SENSITIVE_TOOLS 里、也没有分类器 —— 同一句 `rm -rf ~/x` 走 shell_exec 被 block，
  // 走 terminal_send 却静默执行。等于给授权闸门开了个后门。
  // 因此这里必须复用**同一套**按段分类（含不可逆模式、rm 分级、可疑命令、写文件段）。
  if (toolName === 'terminal_send') return classifyShellCommand(extractShellCommand(argText))

  if (toolName === 'terminal_signal') {
    // Ctrl-C 是"停下当前命令"，几乎总是用户想要的那一下（且可再跑）；
    // 其余信号（KILL/TERM/HUP/QUIT）会直接杀掉会话里的进程，未保存的状态一起没。
    const sig = extractSignalName(argText)
    return sig === 'SIGINT' ? 'allow' : 'ask'
  }

  // ⚠️ 只有 terminal_send / terminal_signal 声明了 requiresApproval ⇒ 只有它们会走到这里。
  //    terminal_open/read/list/close 不进敏感集（开会话、读输出、关自己开的会话都不算不可逆），
  //    给它们写分支等于死代码 —— 2026-10-22 第一版就写了，已删。

  return 'ask' // 未知敏感工具：保守询问（但白名单可放行）
}

/** 从 terminal_signal 的参数里取信号名（缺省 SIGINT，与工具默认值一致） */
function extractSignalName(argText: string): string {
  try {
    const parsed = JSON.parse(String(argText ?? ''))
    const sig = typeof parsed?.signal === 'string' ? parsed.signal.trim().toUpperCase() : ''
    return sig || 'SIGINT'
  } catch {
    return 'SIGINT'
  }
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
