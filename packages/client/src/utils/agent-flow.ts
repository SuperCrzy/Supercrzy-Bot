/**
 * Agent 流事件 → flow 数据操作（从 ChatView handleAgentEvent 拆出的纯逻辑层，可单测）。
 * 职责：工具节点的查找/更新（按 toolCallId 精确归属），不涉及 UI 状态（aiStatus/打字机）。
 * 对齐 WorkBuddy accumulator：toolCallId → contentBlockIndex 的映射由 findToolNode 承载。
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
      // 无 id 匹配（旧事件/增量早期）：记日志便于排查串卡（P0-1 补强，WorkBuddy 全程 toolCallId 归属）
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

/** 工具结果：优先按 toolCallId 精确归属（并行同名不串卡），fallback name；denied/cancelled/error 标记状态 */
export function applyToolResult(msg: ChatMessage, data: any) {
  const terminal: 'done' | 'error' | 'denied' | 'cancelled' =
    data.status === 'denied' ? 'denied' : data.status === 'cancelled' ? 'cancelled' : data.status === 'error' ? 'error' : 'done'
  const targetId = data.tool_call_id || data.toolCallId
  const node = findToolNode(msg, targetId, targetId ? undefined : data.name, true)
  if (!node) return
  node.tool.result = data.content
  node.tool.status = terminal
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

/** 工具名 → 状态词条（对齐 WorkBuddy tool_executing.<工具> 细分映射）。从 ChatView toolStatusLabel 下沉。 */
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

/** 从工具 args 提取"状态条目标宾语"（web_fetch→url、file_*→路径、shell_exec→命令摘要）。
 *  从 ChatView extractToolTarget 下沉；参数解析失败不阻塞返回空串。 */
export function extractToolTarget(name: string, argsRaw: string | undefined): string {
  try {
    const args = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : (argsRaw || {})
    if (name === 'web_fetch' || name === 'web_search') return (args.url || args.query || '').trim()
    if (name.startsWith('file_')) return (args.file_path || args.filePath || args.path || '').trim()
    if (name === 'shell_exec') {
      const c = (args.command || '').trim().replace(/\s+/g, ' ')
      return c.length > 40 ? c.slice(0, 40) + '…' : c
    }
  } catch {
    /* 参数解析失败不阻塞 */
  }
  return ''
}
