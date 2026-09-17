/**
 * 统一「过程阶段」taxonomy（P1-02，2026-09-17）
 *
 * 问题：过程信息密度过高。折叠条在完成态显示的是"N 次工具调用 · M 轮思考"——
 * 数字精确但没有意义（用户不知道这 23 次调用干了什么）；运行态在拿不到工具宾语时
 * 会直接把内部工具名（如 browser / shell_exec）抛给用户看。
 *
 * 本模块把全部工具收敛成 7 个用户能理解的阶段，并作为**全前端唯一**的阶段词表：
 * 折叠条 / 状态条 / 计划胶囊 都从这里取词，避免各写一套。
 *
 * 阶段划分依据"用户关心什么动作"，而非"代码属于哪个模块"：
 *   分析 读取 搜索 编辑 生成 验证 执行
 */

/** 用户面向的 7 个阶段 */
export type AgentStage =
  | 'analyzing'
  | 'reading'
  | 'searching'
  | 'editing'
  | 'generating'
  | 'verifying'
  | 'executing'

/** 固定展示顺序（汇总时按此排序，保证同一任务每次读到的顺序一致） */
export const STAGE_ORDER: readonly AgentStage[] = [
  'analyzing',
  'reading',
  'searching',
  'editing',
  'generating',
  'verifying',
  'executing',
]

/** 阶段 → i18n key（名词形式，用于汇总） */
export const STAGE_I18N: Record<AgentStage, string> = {
  analyzing: 'chat.stageAnalyzing',
  reading: 'chat.stageReading',
  searching: 'chat.stageSearching',
  editing: 'chat.stageEditing',
  generating: 'chat.stageGenerating',
  verifying: 'chat.stageVerifying',
  executing: 'chat.stageExecuting',
}

/**
 * 工具名 → 阶段。**显式映射当前全部 42 个工具**（比前缀猜测准确），
 * 未列入的工具走前缀兜底，再兜底到 executing。
 *
 * 关键约束：**绝不返回原始工具名** —— 用户不该看到 browser / shell_exec 这种内部标识。
 */
const TOOL_STAGE: Record<string, AgentStage> = {
  // ── 分析：规划、澄清、读规范（理解要做什么）
  create_plan: 'analyzing',
  get_goal: 'analyzing',
  ask_question: 'analyzing',
  ask_user: 'analyzing',
  read_me: 'analyzing',
  // ── 读取：查看已有内容
  file_read: 'reading',
  file_exists: 'reading',
  memory_recall: 'reading',
  memory_list: 'reading',
  skill_view: 'reading',
  skill_list: 'reading',
  terminal_read: 'reading',
  task_list: 'reading',
  git_status: 'reading',
  git_diff: 'reading',
  // ── 搜索：找东西
  web_search: 'searching',
  web_fetch: 'searching',
  deep_research: 'searching',
  news_search: 'searching',
  skill_search: 'searching',
  tool_search: 'searching',
  // ── 编辑：改动落盘
  file_write: 'editing',
  file_delete: 'editing',
  multi_edit: 'editing',
  git_commit: 'editing',
  memory_store: 'editing',
  task_create: 'editing',
  task_update: 'editing',
  skill_install: 'editing',
  // ── 生成：产出新内容 / 媒体
  draw_diagram: 'generating',
  generate_image: 'generating',
  make_article: 'generating',
  video_edit: 'generating',
  // ── 验证：检查结果
  lint_file: 'verifying',
  // ── 执行：跑命令、驱动环境
  shell_exec: 'executing',
  computer_use: 'executing',
  browser: 'executing',
  terminal_open: 'executing',
  terminal_send: 'executing',
  terminal_signal: 'executing',
  terminal_close: 'executing',
}

/** 前缀兜底（工具演进/自定义工具时仍归到合理阶段） */
function stageByPrefix(n: string): AgentStage | null {
  if (n.startsWith('file_read') || n.startsWith('file_exists') || n.startsWith('memory_')) return 'reading'
  if (n.startsWith('file_write') || n.startsWith('file_edit') || n.startsWith('file_delete')) return 'editing'
  if (n.startsWith('file_search') || n.startsWith('glob') || n.startsWith('grep') || n.startsWith('web_')) return 'searching'
  if (n.startsWith('lint') || n.startsWith('test') || n.startsWith('validate')) return 'verifying'
  if (n.startsWith('draw') || n.startsWith('generate_') || n.startsWith('make_')) return 'generating'
  if (n.startsWith('create_plan') || n.startsWith('ask_')) return 'analyzing'
  if (n.startsWith('shell') || n.startsWith('terminal') || n.startsWith('computer')) return 'executing'
  return null
}

/** 工具名 → 阶段（永不返回原始工具名） */
export function stageOfTool(toolName: string): AgentStage {
  const n = String(toolName || '').trim()
  if (!n) return 'executing'
  return TOOL_STAGE[n] || stageByPrefix(n) || 'executing'
}

/** 统计所需的最小节点形状：只要 kind 与 tool.name，兼容 ChatFlowNode / FlowDisplayNode 等变体 */
export interface StageStatNode {
  kind?: string
  tool?: { name?: string } | null
}

export interface StageCount {
  stage: AgentStage
  count: number
}

/**
 * 统计一组流节点里的各阶段动作数，按 STAGE_ORDER 返回（只含 count > 0）。
 * 只统计 tool 节点；thinking / text 不是"阶段动作"。
 */
export function stageBreakdown(nodes: readonly StageStatNode[] | undefined): StageCount[] {
  const acc = new Map<AgentStage, number>()
  for (const n of nodes || []) {
    if (!n || n.kind !== 'tool') continue
    const s = stageOfTool(String(n.tool?.name || ''))
    acc.set(s, (acc.get(s) || 0) + 1)
  }
  return STAGE_ORDER.filter((s) => (acc.get(s) || 0) > 0).map((s) => ({ stage: s, count: acc.get(s) || 0 }))
}

/**
 * 把阶段统计渲染成紧凑摘要，最多取前 max 项（默认 3）——
 * 避免"阶段画像"本身又变成一串数字。
 */
export function formatStageBreakdown(
  counts: StageCount[],
  t: (key: string, params?: Record<string, unknown>) => string,
  max = 3,
): string {
  return counts
    .slice(0, max)
    .map((c) => t('chat.stageCount', { stage: t(STAGE_I18N[c.stage]), n: c.count }))
    .join(' · ')
}
