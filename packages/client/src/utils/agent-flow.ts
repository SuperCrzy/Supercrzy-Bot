/**
 * Agent 流事件 → flow 数据操作（从 ChatView handleAgentEvent 拆出的纯逻辑层，可单测）。
 * 职责：工具节点的查找/更新（按 toolCallId 精确归属），不涉及 UI 状态（aiStatus/打字机）。
 * 对齐主流实现 accumulator：toolCallId → contentBlockIndex 的映射由 findToolNode 承载。
 */
import type { ChatMessage } from '@/types'

type ToolNode = Extract<NonNullable<ChatMessage['flow']>[number], { kind: 'tool' }>

/** 终态集合（已完成/拒绝/取消/错误——tool_result 归属时跳过） */
const TERMINAL = new Set(['done', 'error', 'denied', 'cancelled'])

/**
 * 在 flow 中查找工具节点：优先按 toolCallId 精确归属（并行同名工具不串卡），无 id 时按 name 匹配。
 * @param skipTerminal 为 true 时跳过已终态节点（tool_result 用，避免覆盖已完成卡片）
 */
export function findToolNode(
  msg: ChatMessage,
  toolCallId?: string,
  name?: string,
  skipTerminal = false,
): ToolNode | undefined {
  const flow = msg.flow
  if (!flow) return undefined
  for (let i = flow.length - 1; i >= 0; i--) {
    const n = flow[i]
    if (n.kind !== 'tool') continue
    if (toolCallId) {
      if (n.tool.id === toolCallId) return n
      continue
    }
    if (name && n.tool.name === name && (!skipTerminal || !TERMINAL.has(n.tool.status))) {
      // 无 id 匹配（旧事件/增量早期）：记日志便于排查串卡（P0-1 补强，主流实现 全程 toolCallId 归属）
      if (import.meta.env?.DEV) console.warn(`[agent-flow] tool 无 toolCallId 按 name 匹配: ${name}`)
      return n
    }
  }
  return undefined
}

/** 工具参数增量：追加到对应节点；节点未建 → 创建占位（轮末 tool_call 完整参数覆盖）。
 *  增量早期 toolCallId 可能为空 → 按 name 匹配/占位，tool_call 到达时补真实 id（P1-5） */
export function applyToolArgsChunk(msg: ChatMessage, data: any) {
  const chunk = data.chunk || ''
  if (!chunk) return
  const tcId = data.toolCallId || undefined
  let node = findToolNode(msg, tcId, tcId ? undefined : data.name)
  if (!node) {
    node = {
      kind: 'tool',
      tool: { id: data.toolCallId || '', name: data.name || '', arguments: '', status: 'running', startedAt: Date.now() },
    }
    msg.flow!.push(node)
  }
  node.tool.arguments = (node.tool.arguments || '') + chunk
  if (node.tool.status === 'pending') node.tool.status = 'running'
  // 生成期实时 ±（2026-09-25，对齐主流实现 useLiveChangeStats :257044）：文件类工具从
  // args 已到前缀估行数（单调不减），写入 progress.added/deleted → PSL / 工具卡零改动自动实时。
  // server 落盘后的结构化 tool_progress（真值）到达时经 applyToolProgress 合并覆盖估算值。
  if (isFileToolName(node.tool.name)) {
    const live = diffArgsLive(node.tool.name, node.tool.arguments)
    if (live.added || live.deleted) {
      node.tool.progress = { ...(node.tool.progress || {}), ...live, live: true }
    }
  }
}

/** 工具流式输出：按 toolCallId 追加到对应卡片（边跑边显示）；匹配失败时 fallback 按 name（防后端空 id/链路断导致流式输出丢失） */
export function applyToolOutput(msg: ChatMessage, data: any) {
  let node = findToolNode(msg, data.toolCallId)
  if (!node && data.toolCallId) {
    // 兜底：toolCallId 匹配失败（后端偶发空 id/占位节点未补 id）→ 按 name 匹配最近同名工具
    node = findToolNode(msg, undefined, data.name)
    if (node && import.meta.env?.DEV) {
      console.warn(`[agent-flow] tool_output toolCallId 未匹配(${data.toolCallId})，fallback name: ${data.name}`)
    }
  }
  if (!node) return
  node.tool.streamOutput = (node.tool.streamOutput || '') + data.chunk
  if (node.tool.status === 'pending') node.tool.status = 'running'
}

/** 工具结构化进度：按 toolCallId 定位并**合并**（不同工具上报字段子集不同：file_write 给 done/total，multi_edit 给 done/count）。
 *  匹配失败 fallback name（同 applyToolOutput）。只写数值/阶段词，文案一律交前端本地化渲染。 */
export function applyToolProgress(msg: ChatMessage, data: any) {
  let node = findToolNode(msg, data.toolCallId)
  if (!node && data.toolCallId) {
    node = findToolNode(msg, undefined, data.name)
    if (node && import.meta.env?.DEV) {
      console.warn(`[agent-flow] tool_progress toolCallId 未匹配(${data.toolCallId})，fallback name: ${data.name}`)
    }
  }
  if (!node) return
  const { toolCallId: _tcId, name: _name, ...fields } = data
  node.tool.progress = { ...(node.tool.progress || {}), ...fields }
  // server 真值含 ± 行数 → 生成期估算标记作废（此后不再有 args chunk，估算不会再写回）
  if ((fields.added !== undefined || fields.deleted !== undefined) && node.tool.progress) {
    delete node.tool.progress.live
  }
  if (node.tool.status === 'pending') node.tool.status = 'running'
}

/** 工具结果：优先按 toolCallId 精确归属（并行同名不串卡），fallback name；denied/cancelled/error 标记状态 */
export function applyToolResult(msg: ChatMessage, data: any) {
  const terminal: 'done' | 'error' | 'denied' | 'cancelled' =
    data.status === 'denied' ? 'denied' : data.status === 'cancelled' ? 'cancelled' : data.status === 'error' ? 'error' : 'done'
  const targetId = data.tool_call_id || data.toolCallId
  const node = findToolNode(msg, targetId, targetId ? undefined : data.name, true)
  if (!node) return
  node.tool.result = data.content
  node.tool.status = terminal
  // 拒绝/取消/失败收尾：剥离生成期估算的 ±（live 标记还在 = server 真值从未到达），
  // 避免假数字留在历史卡片里（老板红线：沟通工作区的数字不能是错的）
  if (terminal !== 'done' && node.tool.progress?.live) {
    const { added: _a, deleted: _d, live: _l, ...rest } = node.tool.progress
    node.tool.progress = rest
  }
}

/** 工具耗时：优先按 toolCallId（后端已补发 tool_call_id），fallback name；已记录的不覆盖 */
export function applyToolDuration(msg: ChatMessage, data: any) {
  const targetId = data.tool_call_id || data.toolCallId
  const node = findToolNode(msg, targetId, targetId ? undefined : data.name)
  if (!node || node.tool.duration) return
  node.tool.duration = Math.round((data.duration || 0) * 10) / 10
}

/** 流节点 id 生成（统一块模型：thinking/text/diagram 节点补 id，tool 用后端 toolCallId）。
 *  从 ChatView nextNodeId 下沉（2026-08-26 P0-1 步骤 A），保持全量同源。 */
let nodeSeq = 0
export function nextNodeId(): string {
  nodeSeq += 1
  return `n_${Date.now().toString(36)}_${nodeSeq}`
}

/** 工具名 → 状态词条（对齐主流实现 tool_executing.<工具> 细分映射）。从 ChatView toolStatusLabel 下沉。 */
export function toolStatusLabel(toolName: string): string {
  if (toolName.startsWith('shell_')) return 'chat.statusRunningCmd'
  if (toolName.startsWith('file_write') || toolName.startsWith('file_edit')) return 'chat.statusEditingFile'
  if (toolName.startsWith('file_read') || toolName.startsWith('file_exists')) return 'chat.statusReadingFile'
  if (toolName.startsWith('file_search') || toolName.startsWith('glob') || toolName.startsWith('grep')) return 'chat.statusSearchingFiles'
  if (toolName.startsWith('lint_')) return 'chat.statusAnalyzing'
  if (toolName.startsWith('web_search')) return 'chat.statusSearchingWeb'
  if (toolName.startsWith('web_fetch')) return 'chat.statusFetchingWeb'
  if (toolName.startsWith('draw_')) return 'chat.statusDrawing'
  if (toolName.startsWith('git_')) return 'chat.statusGit'
  if (toolName.startsWith('task_')) return 'chat.statusTask'
  if (toolName.startsWith('skill_')) return 'chat.statusSkill'
  if (toolName.startsWith('memory_')) return 'chat.statusMemory'
  if (toolName.startsWith('ask_')) return 'chat.statusAsking'
  if (toolName.startsWith('computer_')) return 'chat.statusComputerUse'
  if (toolName.startsWith('create_plan')) return 'chat.statusPlanning'
  return 'chat.statusWorking'
}

/** 文件类工具名（参数里带路径的工具，含 multi_edit / 各家别名）。
 *  单一来源：`extractToolTarget` 取路径、`process-view` 决定"宾语只显 basename"都用它——
 *  此前 multi_edit 不在 `file_` 前缀里，路径取不到 → 状态行只显示"编辑"没有文件名。 */
export function isFileToolName(name: string): boolean {
  return /^(file_|multi_edit|write_to_file|replace_in_file|append_to_file)/.test(String(name || ''))
}

/** 编辑类工具名（old_str/new_str 形状）；写入类（file_write/write_to_file/append_to_file）走 content 单字段 */
const EDIT_TOOL_RE = /(multi_edit|replace_in_file|edit_file|file_edit)/

/** 字段值起点：`"content"|"new_str"|"old_str"\s*:\s*"`（值从 match 末尾开始） */
const FIELD_VALUE_START_RE = /"(content|new_str|old_str)"\s*:\s*"/g

/**
 * 生成期实时增删估算（2026-09-25，对齐主流实现 useLiveChangeStats :257044 的"按参数前缀做 diff"）：
 * 从（可能不完整的）args JSON 流式前缀统计已写行数。
 *
 *   - 写入类（file_write 等）：第一个 `content` 字段的已到前缀行数 → added；deleted 未知恒 0（真值由 server 补）。
 *   - 编辑类（multi_edit 等）：各 `new_str` 前缀行数累加 → added，各 `old_str` → deleted（估算，真值覆盖）。
 *
 * 行数按 JSON 转义态统计 `\n` 序列（`\\n` = 字面反斜杠+n，不算换行）；**完整行语义**：
 * 只有被 `\n` 终结的行才计数（进行中的尾行不算 → 单调不减），字段闭合时若有残余内容补 1。
 * 纯计数不分配字符串，单遍扫描 O(args 长度)/chunk；写入类只认第一个 content ——
 * 其后是用户文件体，内嵌 `"new_str": "` 字样会造成重复计数。
 * ⚠️ 产出是**估算值**（带 live 标记）：server 落盘后的结构化 tool_progress 是唯一真值。
 */
export function diffArgsLive(toolName: string, argsRaw: string): { added: number; deleted: number } {
  if (!argsRaw || !isFileToolName(toolName)) return { added: 0, deleted: 0 }
  const isEdit = EDIT_TOOL_RE.test(toolName)
  let added = 0
  let deleted = 0
  let contentSeen = false
  FIELD_VALUE_START_RE.lastIndex = 0
  for (;;) {
    const m = FIELD_VALUE_START_RE.exec(argsRaw)
    if (!m) break
    const field = m[1]
    if (isEdit ? field === 'content' : field !== 'content') continue
    if (!isEdit) {
      if (contentSeen) break
      contentSeen = true
    }
    let i = m.index + m[0].length
    let lines = 0
    let lineOpen = false // 当前行已有内容（未被 \n 终结）
    let closed = false
    while (i < argsRaw.length) {
      const ch = argsRaw[i]
      if (ch === '\\') {
        if (i + 1 >= argsRaw.length) break // 流式尾部的残缺转义，下个 chunk 补齐
        if (argsRaw[i + 1] === 'n') {
          lines++
          lineOpen = false
        } else {
          lineOpen = true
        }
        i += 2
        continue
      }
      if (ch === '"') {
        closed = true // 字段闭合
        break
      }
      lineOpen = true
      i++
    }
    if (closed && lineOpen) lines++ // 最后一行无换行结尾，闭合时补计
    if (field === 'old_str') deleted += lines
    else added += lines
  }
  return { added, deleted }
}

/** 流式期从（可能不完整的）args JSON 前缀提取文件路径 —— JSON.parse 在参数未闭合时必失败，
 *  正则兜底（支持转义引号/反斜杠），路径写了一半就返回一半（随 chunk 到齐变完整）。
 *  2026-09-25 老板：正在编辑的框必须显示在编辑什么文件。 */
export function extractPartialFilePath(argsRaw: string | undefined): string {
  if (!argsRaw) return ''
  const m = /"(?:file_path|filePath|path)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(argsRaw)
  if (!m) return ''
  try {
    return JSON.parse(`"${m[1]}"`)
  } catch {
    return m[1]
  }
}

/** 从工具 args 提取"状态条目标宾语"（web_fetch→url、file_*→路径、shell_exec→命令摘要）。
 *  从 ChatView extractToolTarget 下沉；参数解析失败不阻塞返回空串。
 *  流式期参数未闭合 → 文件类工具退 `extractPartialFilePath`（2026-09-25 文件名实时显示）。 */
export function extractToolTarget(name: string, argsRaw: string | undefined): string {
  try {
    const args = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : (argsRaw || {})
    if (name === 'web_fetch' || name === 'web_search') return (args.url || args.query || '').trim()
    if (isFileToolName(name)) return (args.file_path || args.filePath || args.path || '').trim()
    if (name === 'shell_exec') {
      const c = (args.command || '').trim().replace(/\s+/g, ' ')
      return c.length > 40 ? c.slice(0, 40) + '…' : c
    }
  } catch {
    if (isFileToolName(name)) return extractPartialFilePath(argsRaw)
  }
  return ''
}
