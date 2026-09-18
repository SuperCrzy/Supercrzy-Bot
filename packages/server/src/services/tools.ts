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

type ToolExecutor = (args: Record<string, any>, ctx?: ToolExecCtx) => Promise<string>

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



  // ---- 任务工具 ----



  // ---- AskQuestion：Agent 结构化提问（学 Grok）----
  // 需要关键决策/补充信息时向用户提问，挂起等待答复（超时返回超时标记）

  // ---- CreatePlan：Agent 多步骤计划（学 Grok CreatePlan）----
  // 任务较复杂时先创建结构化计划（任务列表 + 子任务），前端以计划卡片展示进度
  // 注：get_goal 已迁至 tools/ 目录（ToolDef 注册表，2026-08-25 工具架构轻量包化示范）

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






  // ---- 可视化指南（WorkBuddy visualizer:read_me 同款）----
  /** 读取项目的可视化操作指南（README/SKILL.md 等），帮助 AI 了解当前工作区约定 */

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

  // ---- 内容工厂：一次跑完(抓取→提炼→配图文) ----

  // ---- AI 浏览器驾驶(让 Agent 自己能开/点/读网页; LLM 逐原语决策) 2026-09-03 ----

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


  // ---- P1 Deep Research Engine：深度研究（多轮递归搜索+提炼 → 3+ 页报告） ----

  // ---- 技能管理工具 ----




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
export const DEFERRED_TOOLS = new Set<string>([
  // ---- 重型生成类：参数多、调用少，最该按需 ----
  'generate_image',
  'video_edit',
  'make_article',
  'draw_diagram',
  // ---- 交互式外部环境：需要 Chrome / 桌面权限，且是长流程 ----
  'browser',
  'computer_use',
  'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list',
  // ---- 扩展能力：技能与记忆（记忆已自动注入上下文，显式检索属按需） ----
  'skill_list', 'skill_search', 'skill_view', 'skill_install',
  'memory_store', 'memory_recall', 'memory_list',
  // ---- 仓库操作：git 三件套（带风险/低频） ----
  'git_status', 'git_diff', 'git_commit',
  // ---- 补充调查类：不作为主干（web_search 已常驻） ----
  'news_search',
  'read_me',
  // ---- 文件辅助：容易被 file_read/file_write/shell_exec 覆盖 ----
  'file_exists', 'file_delete', 'lint_file',
  // ---- 计划辅助：create_plan/task_create/task_update 已常驻，其余按需 ----
  'get_goal', 'task_list',
  // ---- 提问：与常驻的 ask_user 语义重复（同一条前端提问链路），按需即可 ----
  'ask_question',
])

/**
 * 常驻工具数上限（报告指标：普通任务默认注入工具数 ≤ 12）。
 * 改 DEFERRED_TOOLS 时若把常驻数顶超，validateAlwaysOnContract 会直接报错。
 */
export const MAX_ALWAYS_ON_TOOLS = 12

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
