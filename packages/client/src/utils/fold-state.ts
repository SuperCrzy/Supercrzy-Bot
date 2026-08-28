/**
 * 折叠状态机（2026-08-25 重构，收敛今天 5 轮打地鼠补丁）
 *
 * 背景：折叠状态原本被 7 处代码分散写入（content_chunk/tool_call/tool_args_chunk/done/error/finally/历史加载），
 * 事件时序耦合（tool_result 先到还是正文先到）决定行为，导致"并行工具 result 丢失→节点卡 running→
 * hasRunningTool 恒 true→折叠判定失效"这类 bug 反复出现（今天连修 5 轮）。
 *
 * 新设计（对齐 WorkBuddy computeFoldResult 纯函数思路）：
 * - 事件只更新「信号」（textStarted / hasEnd / foldTimerElapsed / userOverride）
 * - 折叠态 = deriveCollapseState(信号) 纯函数推导，事件处理器统一调 applyCollapse 写回 processCollapsed
 * - 单一事实源、可单测、无状态泄漏
 */

export type CollapseSignal = {
  /** 正文（content_chunk）是否已开始输出——含工具间说明与最终正文 */
  textStarted: boolean
  /** 流是否已结束（done / finally） */
  hasEnd: boolean
  /** 800ms 延迟确认定时器是否已触发（正文开始后无新工具信号） */
  foldTimerElapsed: boolean
  /** 用户手动覆盖：展开则一切自动折叠让位；折叠则强制收起 */
  userOverride?: 'folded' | 'expanded'
}

export type CollapseState = 'folded' | 'expanded' | 'auto'

/**
 * 折叠状态推导（纯函数）：
 * - userOverride：用户手动操作最高优先（展开后 done 也不覆盖，对齐"用户手动展开过则不自动折叠"）
 * - hasEnd：流结束 → 折叠（最终态，一次性收敛，稳定不抖）
 * - 其余 → auto（流式中全程平铺，由渲染层 isMsgStreaming 兜底）
 *
 * 2026-08-26 修复（老板反馈"打字机框随回复长短反复伸缩"）：移除了 `textStarted && foldTimerElapsed`
 * 的"中途折叠"分支。原逻辑每段正文开始后 800ms 无新工具就折叠 → 下一个工具信号又取消折叠回到平铺
 * （markToolSignal 清 foldTimerElapsed 不清 textStarted）→ 正文再来再折……文字与工具每交替一轮，
 * 折叠条就"收起→展开"一次，实测高度在 61~441px 往返震荡 6 次（8-26 高度曲线证实）。
 * 改为只认 hasEnd：折叠只在流结束那一瞬发生一次，流式期内容只增不减、框只长不缩。
 */
export function deriveCollapseState(signals: CollapseSignal): CollapseState {
  if (signals.userOverride === 'expanded') return 'expanded'
  if (signals.userOverride === 'folded') return 'folded'
  if (signals.hasEnd) return 'folded'
  return 'auto'
}

/** 状态 → processCollapsed 字段值（渲染层语义：true=折叠 / false=展开 / undefined=流式自动） */
export function collapseStateToField(state: CollapseState): boolean | undefined {
  if (state === 'folded') return true
  if (state === 'expanded') return false
  return undefined
}
