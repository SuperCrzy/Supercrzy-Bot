/**
 * 流式痕迹行视图模型（2026-10-22，问题 B1）
 *
 * 要解决的问题：流式态下过程只有**一行**（ProcessStatusLine 原地演进），动作一换，上一行的
 * 事实就被覆盖 —— 用户回看这段流时看不到"它刚才到底做了什么"，只看到"最后在做什么"。
 * 对标实现的工具行是**累积**的（每行 = 图标 + 人话标题 + 耗时，跑完仍留在那儿）。
 *
 * 为什么单独一个文件：
 *   ① 判定（哪些节点算"已完成的痕迹"、标题取什么、耗时取哪个字段）必须能单测；
 *   ② **文案必须与状态行同源** —— 所以标题不是这里另写一套分支，而是把单个节点喂给
 *      `resolveActiveAction`（它已经把"动词 + 宾语 + 失败/取消措辞 + shell 意图转译"全做完了）。
 *      这样永远不会出现"状态行说'正在跑测试'、痕迹行说'shell_exec'"的自相矛盾。
 *
 * 为什么只留终态节点：非终态的那个正被状态行显示，重复一次就是噪音。
 */

import type { ToolIconType } from './tool-meta'
import { resolveToolMeta } from './tool-meta'
import { resolveActiveAction, TERMINAL_TOOL_STATUSES, type ProcessNodeLike } from './process-view'
import { formatDurationMs } from './tool-summary'

export interface TrailRow {
  /** 稳定 key（tool_call_id 优先；无 id 时用节点下标） */
  key: string
  /** 工具类型字形（唯一来源：tool-meta） */
  icon: ToolIconType
  /** 人话标题（与状态行同一套措辞） */
  label: string
  /** 宾语（文件名/URL/命令），可能为空 */
  target: string
  /** 已格式化的耗时文本（"45s"）；空串 = 不显示 */
  duration: string
  /** 失败（红）/ 取消（中性灰）—— 已完成的正常动作两者都 false */
  failed: boolean
  cancelled: boolean
}

export interface TrailOptions {
  /** 状态行当前显示的动作 key：同一个动作不能既在状态行又在痕迹行 */
  activeKey?: string
  /** 最多保留最近 N 条（默认 10） */
  max?: number
}

/** 单节点耗时：优先结构化 duration（秒），退化用 createTime − startedAt */
export function toolDurationMs(tool: ProcessNodeLike['tool']): number {
  if (!tool) return 0
  const secs = typeof tool.duration === 'number' ? tool.duration : 0
  if (secs > 0) return secs * 1000
  const a = tool.startedAt
  const b = tool.createTime
  if (typeof a === 'number' && typeof b === 'number' && b > a) return b - a
  return 0
}

/**
 * 把过程节点折算成"已完成的痕迹行"（时间正序，末尾是最新的）。
 *
 * 不变量：
 * - 只含终态工具节点 —— 非终态一定由状态行承担，这里出现就是重复；
 * - `activeKey` 命中的那条被剔除（状态行刚切到同一个动作时）；
 * - 顺序 = 节点顺序（不重排、不聚合）—— 聚合会把"读 → 改 → 跑"的因果顺序藏起来。
 */
export function resolveTrailRows(
  nodes: readonly ProcessNodeLike[],
  t: (key: string, params?: Record<string, unknown>) => string,
  opts: TrailOptions = {},
): TrailRow[] {
  const rows: TrailRow[] = []
  nodes.forEach((node, i) => {
    if (node.kind !== 'tool' || !node.tool) return
    const status = String(node.tool.status || '')
    if (!TERMINAL_TOOL_STATUSES.has(status)) return
    const key = `tool:${node.tool.id || i}`
    if (opts.activeKey && key === opts.activeKey) return
    // 单节点喂给状态行的解析器：复用它的人话措辞，杜绝两套文案漂移。
    // （传单元素数组而不是原数组：否则 pickToolNode 会回头挑更早的节点，标题就串了。）
    const action = resolveActiveAction([node], t)
    rows.push({
      key,
      icon: resolveToolMeta(String(node.tool.name || '')).icon,
      label: action.label,
      target: action.target,
      duration: formatDurationMs(toolDurationMs(node.tool)),
      failed: status === 'error',
      cancelled: status === 'denied' || status === 'cancelled' || status === 'skipped' || status === 'destroyed',
    })
  })
  const max = opts.max && opts.max > 0 ? opts.max : 10
  return rows.length > max ? rows.slice(-max) : rows
}
