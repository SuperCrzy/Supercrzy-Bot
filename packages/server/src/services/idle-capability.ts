/**
 * 闲置能力建议（G3，2026-10-23）。
 *
 * 修的是什么：43 个注册工具里 16 个从未被真实调用（口径 = playbook.tools_used，
 * 2026-09-24 实测），能力装了没人用，且系统自己不知道该建议谁。
 *
 * 规则（backlog G3 定稿）：
 *  - 按**天**记账：闲置天数 = today − max(lastUsed)（从未用过 → 用系统观测起点起算）；
 *  - 闲置 ≥ minIdleDays（默认 14）才建议；
 *  - **安装日封顶**：firstSeen 是当天的能力不推（刚装 ≠ 闲置）；
 *  - dismiss 带版本号：同版本内 dismiss 过的不再推；**能力清单版本变化后重新出现**
 *    （版本 = 工具名 + 描述的稳定签名 —— 描述改了说明能力变了，旧 dismiss 不再适用）。
 *
 * 纯函数 + 注入时钟，方便断言：①当天新装不推；②dismiss v1 后 v2 仍出现；
 * ③16 个工具能算出闲置天数并给出建议。
 */

/** 单个工具的闲置建议（reason 是机器标识，展示文案由前端 i18n 负责） */
export interface IdleSuggestion {
  tool: string
  /** 机器标识：'never-used' | 'idle' */
  reason: 'never-used' | 'idle'
  /** 闲置天数（从未用过 = 观测起点起算） */
  idleDays: number
  /** 最近一次使用日期（ISO YYYY-MM-DD），从未用过为 null */
  lastUsed: string | null
}

export interface DismissRecord {
  tool: string
  /** dismiss 时的能力清单版本（capabilityVersion） */
  version: string
}

export interface IdleInput {
  /** 今天（ISO YYYY-MM-DD，调用方注入以便测试） */
  today: string
  /** 注册表全量：{ name, description } */
  catalog: Array<{ name: string; description?: string }>
  /** 用量台账（playbook）：每行的 tools_used + 日期 */
  usage: Array<{ toolsUsed: string[]; date: string }>
  /** 各能力的"首次出现"日期（内置工具 = 系统观测起点；技能工具 = 安装日） */
  firstSeen?: Record<string, string>
  /** 已 dismiss 记录（settings 持久化） */
  dismissed?: DismissRecord[]
  /** 当前能力清单版本 */
  version: string
  /** 闲置阈值天数，默认 14 */
  minIdleDays?: number
}

/** 能力清单稳定签名：名 + 描述排序后 sha256 前 8 位（描述改 → 版本变 → 旧 dismiss 失效） */
export function capabilityVersion(catalog: Array<{ name: string; description?: string }>): string {
  const stable = catalog
    .map((t) => `${t.name}\u0000${t.description ?? ''}`)
    .sort()
    .join('\u0001')
  // 纯 Node 实现，避免引 crypto 依赖差异（服务端本来就有 node:crypto，这里保持同步纯函数用简易 FNV）
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < stable.length; i++) {
    const c = stable.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).slice(0, 12)
}

function dayDiff(a: string, b: string): number {
  const ta = Date.parse(a + 'T00:00:00Z')
  const tb = Date.parse(b + 'T00:00:00Z')
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0
  return Math.round((ta - tb) / 86400000)
}

export function computeIdleSuggestions(input: IdleInput): { suggestions: IdleSuggestion[]; idleDays: Record<string, number> } {
  const minIdleDays = input.minIdleDays ?? 14
  const dismissed = new Map((input.dismissed ?? []).map((d) => [d.tool, d.version]))

  // 最近使用日：台账逐行扫描（台账 ≤ 数百行，聚合成本可忽略）
  const lastUsed = new Map<string, string>()
  for (const row of input.usage) {
    for (const t of row.toolsUsed) {
      const prev = lastUsed.get(t)
      if (!prev || row.date > prev) lastUsed.set(t, row.date)
    }
  }
  // 观测起点 = 台账最早日期（从未用过的工具从这里起算闲置）
  const observationStart = input.usage.reduce<string | null>(
    (min, r) => (!min || r.date < min ? r.date : min), null)

  const idleDays: Record<string, number> = {}
  const suggestions: IdleSuggestion[] = []

  for (const t of input.catalog) {
    const last = lastUsed.get(t.name) ?? null
    const since = input.firstSeen?.[t.name] ?? observationStart
    // 安装日封顶：当天新装（firstSeen = today）不推
    if (since && dayDiff(input.today, since) < 1) continue
    const days = last ? dayDiff(input.today, last) : (observationStart ? dayDiff(input.today, observationStart) : 0)
    idleDays[t.name] = days
    if (days < minIdleDays) continue
    // 同版本内 dismiss 过的不再推；版本变了（能力描述/清单变化）重新出现
    if (dismissed.get(t.name) === input.version) continue
    suggestions.push({
      tool: t.name,
      reason: last ? 'idle' : 'never-used',
      idleDays: days,
      lastUsed: last,
    })
  }

  suggestions.sort((a, b) => b.idleDays - a.idleDays || a.tool.localeCompare(b.tool))
  return { suggestions, idleDays }
}
