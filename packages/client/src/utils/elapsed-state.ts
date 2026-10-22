/**
 * 整轮耗时徽标的**状态判定**（2026-10-22，问题 A3）
 *
 * 背景（为什么单独抽出来）：
 *   `ElapsedBadge` 原先只有两态（运行中 / 已完成），第三态「已取消」缺失，导致
 *     ① 点"停止"后 `running=false` 且 `elapsedMs` 未写 → 徽标**整块消失**；
 *     ② 刷新后 `stores/chat.ts` 会给任意 assistant 消息反算 `elapsedMs` → 取消的那轮
 *        被渲染成「已完成 Xs」（事实错误）。
 *   这两条都只由输入决定，写在组件里就只能靠真机点停止来验 —— 抽成纯函数后可断言。
 *
 * 优先级刻意是 aborted > done：后端/直连两条路都可能既写了 elapsedMs 又标了中止，
 * 此时"被中止"是更准确的事实（不能因为有时长就当成跑完了）。
 */

export type ElapsedState = 'hidden' | 'running' | 'done' | 'aborted'

export interface ElapsedInput {
  /** 这一轮被用户停止（消息级标记，流式时由 stopGeneration 写入） */
  aborted?: boolean
  /** 已定格的耗时（ms）；有值即不再计时 */
  elapsedMs?: number
  /** 该轮是否仍在运行 */
  running?: boolean
  /** 计时起点（ms 时间戳） */
  startedAt?: number
  /** 当前时刻（ms）；仅运行态需要，缺省视为不可计时 */
  nowMs?: number
}

export interface ElapsedView {
  state: ElapsedState
  /** 要展示的耗时（ms）；hidden 时为 0 */
  ms: number
}

/** 少于 1 秒按 1 秒展示，避免出现无意义的 "0s"；NaN 也归到 1 秒（时钟异常不能显示 "NaNs"） */
const atLeastOneSecond = (ms: number) => (Number.isFinite(ms) ? Math.max(1000, Math.round(ms)) : 1000)

export function resolveElapsedView(i: ElapsedInput): ElapsedView {
  const frozen = typeof i.elapsedMs === 'number' && Number.isFinite(i.elapsedMs) && i.elapsedMs > 0 ? i.elapsedMs : 0
  const live = i.startedAt && typeof i.nowMs === 'number' ? i.nowMs - i.startedAt : 0

  if (i.aborted) {
    // 取消：有定格用定格，没有（点停止瞬间还没写）就用起点算出来——绝不留空
    return { state: 'aborted', ms: frozen || atLeastOneSecond(live) }
  }
  if (frozen) return { state: 'done', ms: frozen }
  if (i.running && i.startedAt) return { state: 'running', ms: atLeastOneSecond(live) }
  return { state: 'hidden', ms: 0 }
}
