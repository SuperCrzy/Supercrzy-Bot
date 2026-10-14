import { onUnmounted, ref, watch, type Ref } from 'vue'

/**
 * 墙钟秒针：只在 active 为真期间运行，且每次 tick 都调度到 **锚点之后的下一个整秒**。
 *
 * 为什么不是 `setInterval(() => now.value = Date.now(), 1000)`：
 *
 * 1. `setInterval` 的相位取决于"什么时候起的定时器"，与真实经过时间无关。
 *    若配合 `toFixed(1)` 显示，小数位其实是**定时器相位**（例如恒定显示 "12.3s"），
 *    既没有精度意义，又与其他计时器对不齐。
 * 2. 多个计时器各自 setInterval ⇒ 相位各异 ⇒ 同屏两个都显示耗时的地方会在
 *    **不同时刻**跳秒（底部徽标已 12s、折叠条还停在 11s）。锚到同一起点后
 *    它们在同一时刻跳动，数字恒等。
 *
 * @param active 是否计时（变假立即停表，避免后台空转）
 * @param anchor 计时起点（毫秒时间戳 getter）。给了它，跳秒时刻 = 起点 + k×1000s，
 *               即"刚好满 N 秒"时数字才变成 N；不给则退化为"距本次起的表 1s"。
 *
 * 组件卸载自动清理。
 */
export const GRANULARITY_MS = 1000
/** 下限延迟：防止时钟回拨等异常导致 0ms 延迟的忙循环 */
export const MIN_DELAY_MS = 16

/**
 * 距"锚点之后的下一个整秒"还有多少毫秒。
 *
 * 纯函数，与 Vue 无关 —— 抽出它是为了能被单测直接断言不变量，而不是靠读代码相信。
 *
 * 不变量：
 * - 返回 `GT`（锚点后 k 秒）时，`nowMs + delay === anchorMs + k*1000`，即触发时刻正好落在整秒上；
 * - 永不返回 0（否则 setTimeout 会退化成同步忙循环）；
 * - 时钟回拨（nowMs < anchorMs）时退化为等待一个完整周期。
 */
export function nextSecondBoundaryDelay(nowMs: number, anchorMs: number): number {
  const elapsed = nowMs - anchorMs
  if (!Number.isFinite(elapsed) || elapsed < 0) return GRANULARITY_MS
  const delay = GRANULARITY_MS - (elapsed % GRANULARITY_MS)
  return Math.max(MIN_DELAY_MS, delay)
}

export function useSecondTick(
  active: () => boolean,
  anchor?: () => number | undefined,
): Readonly<Ref<number>> {
  const now = ref(Date.now())
  let timer: ReturnType<typeof setTimeout> | null = null

  function stop() {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function schedule() {
    // 有锚点就按"锚点 + k×1s"对齐；没有锚点则退化为从现在起算满 1s
    const base = anchor?.() ?? now.value
    timer = setTimeout(() => {
      timer = null
      if (!active()) return
      now.value = Date.now()
      schedule()
    }, nextSecondBoundaryDelay(Date.now(), base))
  }

  watch(active, (on) => {
    stop()
    if (!on) return
    now.value = Date.now()
    schedule()
  }, { immediate: true })

  onUnmounted(stop)

  return now
}
