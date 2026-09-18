/**
 * 工具摘要描述符表 + 折叠条摘要合成（对齐 WorkBuddy metaFold.summary：动词+宾语）
 *
 * WorkBuddy 原版：TOOL_DESCRIPTORS（canonical/aliases/actionKey/objectFields/noObjectKey）
 * → extractAtom（从工具参数提取动作+宾语）→ selectSummary → renderTemplate（"{verb} {object}"）
 */
import type { ChatFlowNode } from '@/types'

interface ToolDescriptor {
  /** 动词 i18n key（如 "运行命令" / "Run command"） */
  actionKey: string
  /** 宾语字段优先级（从工具 arguments 里提取） */
  objectFields: string[]
}

const TOOL_DESCRIPTORS: Record<string, ToolDescriptor> = {
  shell_exec: { actionKey: 'chat.sumCmd', objectFields: ['description', 'command'] },
  file_read: { actionKey: 'chat.sumRead', objectFields: ['file_path', 'filePath', 'path'] },
  file_write: { actionKey: 'chat.sumWrite', objectFields: ['file_path', 'filePath', 'path'] },
  file_exists: { actionKey: 'chat.sumCheck', objectFields: ['file_path', 'filePath', 'path'] },
  file_search: { actionKey: 'chat.sumSearchFile', objectFields: ['query', 'pattern'] },
  glob: { actionKey: 'chat.sumSearchFile', objectFields: ['pattern', 'query'] },
  grep: { actionKey: 'chat.sumSearchCode', objectFields: ['pattern', 'query'] },
  lint_file: { actionKey: 'chat.sumLints', objectFields: ['file_path', 'path'] },
  web_search: { actionKey: 'chat.sumWebSearch', objectFields: ['query'] },
  web_fetch: { actionKey: 'chat.sumWebFetch', objectFields: ['url', 'title'] },
  draw_diagram: { actionKey: 'chat.sumDraw', objectFields: ['title'] },
  git_status: { actionKey: 'chat.sumGitStatus', objectFields: [] },
  git_diff: { actionKey: 'chat.sumGitDiff', objectFields: [] },
  git_commit: { actionKey: 'chat.sumGitCommit', objectFields: ['message'] },
  task_create: { actionKey: 'chat.sumTask', objectFields: ['title'] },
  task_list: { actionKey: 'chat.sumTask', objectFields: [] },
  task_update: { actionKey: 'chat.sumTask', objectFields: ['task_id'] },
  skill_list: { actionKey: 'chat.sumSkill', objectFields: [] },
  skill_search: { actionKey: 'chat.sumSkill', objectFields: ['query', 'keyword'] },
  skill_install: { actionKey: 'chat.sumSkill', objectFields: ['name', 'skill_name'] },
  skill_view: { actionKey: 'chat.sumSkill', objectFields: ['name', 'skill_name'] },
  memory_store: { actionKey: 'chat.sumMemory', objectFields: [] },
  memory_recall: { actionKey: 'chat.sumMemory', objectFields: [] },
  memory_list: { actionKey: 'chat.sumMemory', objectFields: [] },
  // 2026-09-18（#147）：整理记忆是破坏性操作，折叠条单独给个动词，别与"存储/回忆"混在一起
  memory_consolidate: { actionKey: 'chat.sumConsolidate', objectFields: [] },
  create_plan: { actionKey: 'chat.sumPlan', objectFields: ['task', 'goal'] },
  ask_question: { actionKey: 'chat.sumAsk', objectFields: ['question'] },
  ask_user: { actionKey: 'chat.sumAsk', objectFields: ['question'] },
  computer_use: { actionKey: 'chat.sumComputer', objectFields: [] },
}

const FALLBACK_ACTION_KEY = 'chat.sumFallback'
/** 宾语截断长度（超长参数如 command 只取开头） */
const OBJECT_MAX_LEN = 24

/** 解析工具 arguments（兼容字符串/对象） */
function parseArgs(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

/** 从工具节点提取"动作 + 宾语"原子 */
function extractAtom(node: Extract<ChatFlowNode, { kind: 'tool' }>): { actionKey: string; object: string } {
  const name = node.tool?.name || ''
  const desc = TOOL_DESCRIPTORS[name] || { actionKey: FALLBACK_ACTION_KEY, objectFields: [] }
  const args = parseArgs(node.tool?.arguments)
  for (const field of desc.objectFields) {
    const v = args[field]
    if (typeof v === 'string' && v.trim()) {
      const trimmed = v.trim().replace(/\s+/g, ' ')
      return { actionKey: desc.actionKey, object: trimmed.length > OBJECT_MAX_LEN ? trimmed.slice(0, OBJECT_MAX_LEN) + '…' : trimmed }
    }
  }
  return { actionKey: desc.actionKey, object: '' }
}

/**
 * 折叠条摘要合成（对齐 WorkBuddy metaFold.summary）：
 * - 单动作：动词（无宾语）→ "运行命令"；有宾语 → "读取 src/utils.ts"
 * - 多动作（≤3）：顿号连接 → "运行命令、修改：topic"
 * - 多动作（>3）：分类计数 → "5 类操作"
 */
export function composeFoldSummary(flow: ChatFlowNode[] | undefined, t: (key: string) => string): string {
  const tools = (flow || []).filter((n): n is Extract<ChatFlowNode, { kind: 'tool' }> => n.kind === 'tool')
  if (!tools.length) return ''

  // 提取原子并按键合并（同动作的宾语去重合并）
  const merged = new Map<string, Set<string>>()
  for (const node of tools) {
    const { actionKey, object } = extractAtom(node)
    if (!merged.has(actionKey)) merged.set(actionKey, new Set())
    if (object) merged.get(actionKey)!.add(object)
  }

  const segments: string[] = []
  for (const [actionKey, objs] of merged) {
    const verb = t(actionKey)
    if (!objs.size) segments.push(verb)
    else if (objs.size === 1) segments.push(`${verb} ${[...objs][0]}`)
    else segments.push(`${verb} ${objs.size} 处`)
  }

  if (segments.length === 1) return segments[0]
  if (segments.length <= 3) return segments.join('、')
  return t('chat.sumCategoryCount').replace('{n}', String(segments.length))
}

/** 时长格式（对齐 WorkBuddy formatDurationMs）：≥1h → "1h23m"；≥1m → "5m17s"；<1m → "42s" */
export function formatDurationMs(ms: number | undefined | null): string {
  if (!ms || ms < 0) return ''
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${minutes}m`
  if (minutes > 0) return `${minutes}m${seconds}s`
  return `${seconds}s`
}
