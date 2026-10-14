// PSL 视图模型
/**
 * 过程状态行视图模型（I13，2026-09-24）
 *
 * 从 `components/chat/ProcessStatusLine.vue` 下沉的**纯逻辑**：单行原地演进要显示"哪一个动作"、
 * 进度痕迹画几个点、实时数字取哪几个字段。
 *
 * 为什么必须下沉：I13 的核心风险不在渲染而在**判定**——
 *   - 待审批(pending) / 执行中(running) / 已完成(terminal) 三态优先级；
 *   - 并行工具时"最新的非终态"而不是"最后一个"；
 *   - 思考完成但下一个工具尚未到达时的空窗；
 *   - thinking-group 一个节点折算成 turns.length 个动作（否则圆点数对不上）。
 * 这些规则写在 .vue 里就无法单测（只能靠真机肉眼），所以收敛到这里。
 *
 * 输入类型用**结构化**（`ProcessNodeLike`）而不是 ChatFlowNode 联合类型：
 * 调用方传的是 MessageFlowRenderer 的 FlowDisplayNode[]（含 text/diagram/image 等非过程节点），
 * 用结构化类型可以零强转接收，函数内部自行忽略非过程节点。
 */
import type { ChatFlowNode, ToolProgress } from '@/types'
import { composeFoldSummary } from './tool-summary'
import { stageOfTool, STAGE_I18N } from './stage'
import { extractToolTarget, isFileToolName } from './agent-flow'

/** 工具终态集合（与 agent-flow.TERMINAL / MessageFlowRenderer.TOOL_TERMINAL 同口径） */
export const TERMINAL_TOOL_STATUSES = new Set(['done', 'error', 'denied', 'cancelled', 'skipped', 'destroyed'])

export interface ProcessNodeLike {
  kind?: string
  id?: string
  /** thinking 节点是否已完成 */
  completed?: boolean
  /** thinking-group 的轮次 */
  turns?: Array<{ completed?: boolean }>
  tool?: {
    id?: string
    name?: string
    status?: string
    arguments?: string
    progress?: ToolProgress
  }
}

export interface ActiveAction {
  /** 变化即触发"旧滑出 + 新滑入 + 扫光"（Transition :key） */
  key: string
  label: string
  target: string
  running: boolean
  pending: boolean
  /** 2026-09-26：终态细分——error 用红 ✕（此前 error 落进 psl--done 显示绿勾，错误被标成"完成"） */
  failed?: boolean
  cancelled?: boolean
}

/** 取"当前动作"的工具节点：优先最右侧的**非终态**工具（并行时取最新），否则最右侧工具 */
function pickToolNode(nodes: readonly ProcessNodeLike[]): { node: ProcessNodeLike; index: number } | null {
  let fallback: { node: ProcessNodeLike; index: number } | null = null
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (n.kind !== 'tool' || !n.tool) continue
    if (!fallback) fallback = { node: n, index: i }
    if (!TERMINAL_TOOL_STATUSES.has(String(n.tool.status || ''))) return { node: n, index: i }
  }
  return fallback
}

/** 动词机器标识 → i18n（对齐 WorkBuddy `tool.writeFile.{creating,create,editing,edit}` 动词表） */
const PHASE_VERB_I18N: Record<string, string> = {
  create: 'chat.procVerbCreate',
  edit: 'chat.procVerbEdit',
}

/**
 * shell 命令 → 意图文案 i18n key（2026-09-26 pill 智能化①，老板拍板 1+3+4+5）。
 * pill 上 40 字命令摘要是最大的"技术腔"来源：`npm test` →「正在跑测试」这种查表转译，
 * 查不到的命令兜底原摘要（宁要真实的机器语，不要编造的人话）。
 * 取 `&&` 链的**末段**判定（`cd /a && npm test` 的意图是测试）。匹配顺序敏感：更具体的在前。
 */
const SHELL_INTENT_RE: Array<[RegExp, string]> = [
  [/\b(npm|pnpm|yarn)\s+(run\s+)?test\b|^(vitest|jest)\b|\bnpx\s+vitest\b/, 'chat.shellTest'],
  [/\b(npm|pnpm|yarn)\s+run\s+build\b|\bvite\s+build\b|\btsc\b/, 'chat.shellBuild'],
  [/\b(npm|pnpm|yarn)\s+(install|i|add)\b/, 'chat.shellInstall'],
  [/\bgit\s+commit\b/, 'chat.shellCommit'],
  [/\bgit\s+push\b/, 'chat.shellPush'],
  [/\bgit\s+(pull|fetch)\b/, 'chat.shellPull'],
  [/\bgit\s+(status|diff|log|show|branch)\b/, 'chat.shellGitView'],
  [/^(ls|find|fd|rg|grep|tree)\b/, 'chat.shellFind'],
  [/^(node|tsx|ts-node|python3?|pip3?)\b/, 'chat.shellRun'],
  [/^(curl|wget)\b/, 'chat.shellFetch'],
  [/^(rm|rmdir)\b/, 'chat.shellClean'],
  [/^(mkdir|mv|cp|touch|ln)\b/, 'chat.shellOrganize'],
  [/^(cat|head|tail|wc)\b/, 'chat.shellRead'],
]

export function shellIntentKey(command: string): string | null {
  const raw = String(command || '').trim().toLowerCase()
  if (!raw) return null
  const segs = raw.split('&&').map((s) => s.trim()).filter(Boolean)
  const last = segs[segs.length - 1] || ''
  for (const [re, key] of SHELL_INTENT_RE) if (re.test(last)) return key
  return null
}

/** 阅读类工具（同质动作，连续多次可聚合为 N/M 进度感） */
const AGGREGATABLE_TOOL_RE = /^(file_read|read_file|file_search|glob|grep)/

/** 从 picked 位置往前数**同类阅读工具**的连续出现数：thinking 不断链，其他工具才断 */
function countTrailingSameTool(nodes: readonly ProcessNodeLike[], name: string, uptoIndex: number): number {
  let n = 0
  for (let i = uptoIndex; i >= 0; i--) {
    const x = nodes[i]
    if (x.kind === 'thinking' || x.kind === 'thinking-group') continue
    if (x.kind === 'tool' && x.tool?.name === name) {
      n++
      continue
    }
    break
  }
  return n
}

/** 文件类工具：宾语只显 basename —— 绝对路径动辄 80+ 字符，单行显示不下，
 *  且前 24 字符全是 `/Users/<name>/…` 这种零信息量的前缀（composeFoldSummary 的截断正好砍在这里）。
 *  判定复用 `agent-flow.isFileToolName`（单一来源）。 */
export function shortTarget(name: string, raw: string): string {
  if (!raw) return ''
  if (!isFileToolName(name)) return raw
  const seg = raw.split(/[\\/]/).filter(Boolean).pop()
  return seg || raw
}

/**
 * 当前动作（单行状态行唯一渲染源）。
 * 优先级：①未完成思考 → ②非终态工具（pending 措辞为"待确认"）→ ③已完成思考 → ④最后一个工具 → 兜底。
 *
 * 动词与宾语的分工：
 *   - 文件类：动词走 `phase`（创建/编辑），宾语走 **basename**；
 *   - 其他：动词走工具描述符（"读取 / 搜索代码 / 运行命令"），宾语走参数里的 URL/命令/查询词；
 *     拿不到宾语时退到**阶段名**（"执行 / 搜索"）——绝不把内部工具名（browser / shell_exec）抛给用户；
 *   - 执行中统一加"正在"前缀（对齐 WorkBuddy「生成中 / 修改中」的在途措辞）。
 */
export function resolveActiveAction(
  nodes: readonly ProcessNodeLike[],
  t: (key: string, params?: Record<string, unknown>) => string,
): ActiveAction {
  // ① 未完成的思考
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (n.kind === 'thinking' && !n.completed) {
      return { key: `think:${n.id || i}`, label: t('chat.thinking'), target: '', running: true, pending: false }
    }
  }
  // ②/③ 工具
  const picked = pickToolNode(nodes)
  if (picked) {
    const { node, index } = picked
    const status = String(node.tool?.status || '')
    const name = String(node.tool?.name || '')
    const pending = status === 'pending'
    const running = !TERMINAL_TOOL_STATUSES.has(status)
    const rawTarget = extractToolTarget(name, node.tool?.arguments)
    const stage = t(STAGE_I18N[stageOfTool(name)]) || t('chat.statusWorking')
    let verb = ''
    let target = ''
    if (pending) {
      verb = t('chat.procPending')
    } else if (isFileToolName(name)) {
      const phaseKey = node.tool?.progress?.phase ? PHASE_VERB_I18N[node.tool.progress.phase] : ''
      verb = (phaseKey && t(phaseKey)) || stage
      target = shortTarget(name, rawTarget)
    } else {
      // 工具描述符已产出"动词 宾语"；拿不到宾语时退到阶段名
      // （⚠️ 不能写成 `summary || stage`：composeFoldSummary 对未登记工具永远返回
      //   `chat.sumFallback`（"处理"），会让 stage 分支成为死代码，browser/terminal_* 只会显示"处理"）
      const summary = composeFoldSummary([node as unknown as ChatFlowNode], (k: string) => t(k) || k)
      const hasObject = !!summary && /\s/.test(summary)
      verb = hasObject ? summary : stage
      target = hasObject ? '' : shortTarget(name, rawTarget)
    }
    // 终态细分（2026-09-26）：error/denied/cancelled 不再落进"完成"绿勾
    const failed = status === 'error'
    const cancelled = status === 'denied' || status === 'cancelled' || status === 'skipped' || status === 'destroyed'
    let label = pending ? verb : running ? t('chat.processRunning', { action: verb }) : verb
    if (failed) label = t('chat.procError')
    else if (cancelled) label = t('chat.procCancelled')
    // pill 智能化①（2026-09-26 老板拍板）：shell 命令意图转译——查表命中用人话，兜底原摘要；
    // 转译文案不带命令宾语（命令里的路径/参数是技术噪音）
    else if (running && name === 'shell_exec') {
      const intentKey = shellIntentKey(extractToolTarget(name, node.tool?.arguments))
      if (intentKey) {
        label = t(intentKey)
        return { key: `tool:${node.tool?.id || index}`, label, target: '', running, pending, failed, cancelled }
      }
    }
    // pill 智能化④：同质阅读动作连续出现 → 聚合「正在查找相关文件 · 第 N 个」，消除走马灯
    else if (running && AGGREGATABLE_TOOL_RE.test(name)) {
      const n = countTrailingSameTool(nodes, name, index)
      if (n >= 2) {
        label = t('chat.procAggRead', { n })
        return {
          key: `tool:${node.tool?.id || index}`,
          label,
          target: shortTarget(name, rawTarget),
          running,
          pending,
          failed,
          cancelled,
        }
      }
    }
    return {
      key: `tool:${node.tool?.id || index}`,
      label,
      target,
      running,
      pending,
      failed,
      cancelled,
    }
  }
  // ④ 只剩已完成的思考
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (n.kind === 'thinking') {
      return { key: `think:${n.id || i}`, label: t('chat.thinking'), target: '', running: false, pending: false }
    }
  }
  return { key: 'none', label: t('chat.processCollapsed'), target: '', running: false, pending: false }
}

/** 一个节点折算成几个"动作"（thinking-group 展开成 turns 个数，否则圆点数对不上实际动作） */
export function actionStat(n: ProcessNodeLike): { total: number; done: number } {
  if (n.kind === 'thinking-group') {
    const total = Array.isArray(n.turns) ? n.turns.length : 0
    return { total, done: total }
  }
  if (n.kind === 'tool') return { total: 1, done: TERMINAL_TOOL_STATUSES.has(String(n.tool?.status || '')) ? 1 : 0 }
  if (n.kind === 'thinking') return { total: 1, done: n.completed ? 1 : 0 }
  return { total: 0, done: 0 }
}

export interface TrailView {
  show: boolean
  /** 要画的圆点数（>6 时退化为 0，改显示 fraction） */
  dots: number
  done: number
  fraction: string
}

/** 进度痕迹：≤6 个动作画圆点（已完成实心），>6 退化 `done/total` */
export function resolveTrail(nodes: readonly ProcessNodeLike[]): TrailView {
  let total = 0
  let done = 0
  for (const n of nodes) {
    const s = actionStat(n)
    total += s.total
    done += s.done
  }
  if (total <= 1) return { show: false, dots: 0, done, fraction: '' }
  if (total <= 6) return { show: true, dots: total, done, fraction: '' }
  return { show: true, dots: 0, done, fraction: `${done}/${total}` }
}

export interface CounterView {
  show: boolean
  added: number
  deleted: number
  /** 写入行数 / 编辑处数 的分数文案（无法判定时为空） */
  frac: string
}

/**
 * 实时数字：只认结构化进度，不解析任何中文文案。
 * 靠**字段形状**区分两类，不靠工具名：
 *   - 多处编辑形状（`count` + `done`）→ **只显处数，不显 ±**
 *   - 整文件写入形状（`total` + `done`）→ ± 与 `done/total 行` 都显
 *
 * ⚠️ 为什么多处编辑要藏 ±：那对数字是"每处 `old_str`→`new_str` 的**局部** diff"累加，
 * 一次纯插入（用锚点行换 锚点行+N 行）会算成 `+N+1 / −1`，读者会误当成整文件净变化。
 * WorkBuddy 同样对 multi_edit 只显 `{count} 处修改`、不给 ±
 * （取证：`docs/WORKBUDDY_TOOLCARD_MCP_SANDBOX_2026-09-24.md` §1.5）。
 * 数字宁可不显，也不能显一个会被读错的。
 */
export function resolveCounter(
  progress: ToolProgress | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
): CounterView {
  if (!progress) return { show: false, added: 0, deleted: 0, frac: '' }
  // 2026-09-25 老板定稿格式「正在编辑 snake.html +10 -1」：统一只显 ± 累计增删。
  // （2026-09-26 曾试加「约 N%」进度，老板裁决撤掉：百分比不体现智能化，维持纯 ±）
  const added = progress.added || 0
  const deleted = progress.deleted || 0
  return { show: !!(added || deleted), added, deleted, frac: '' }
}
