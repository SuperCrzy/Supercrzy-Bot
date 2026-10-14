/**
 * 秒针边界对齐的不变量（2026-09-24）
 *
 * 背景：`useSecondTick` 取代了三处独立的 `setInterval(..., 1000)`（底部耗时徽标 /
 * 折叠条 / 工具头）。旧写法的"跳秒时刻"取决于定时器**起表时刻**，于是同一条回复
 * 的底部与折叠条会在不同时刻跳秒（出现 12s / 11s 并存）；配合 `toFixed(1)` 时
 * 小数位其实是"相位"，既无精度意义又对不齐。
 *
 * 这里断言的是**不变量**，不是"调用了几次"这类代理指标：
 *   I1 触发时刻恰好落在锚点的整秒上（now + delay === anchor + k*1000）
 *   I2 delay 永不为 0（否则 setTimeout 退化成忙循环）
 *   I3 时钟回拨时不产生负延迟
 *   I4 两个锚点相同的计时器，无论各自何时起表，跳秒时刻集合完全一致
 *
 * I4 是本次重构的核心目的，也是最容易写错的地方（第一版实现把相位锚在"起表时刻"
 * 而非"起点"，能通过 I1/I2 但会破坏 I4 —— 所以这条必须单独测）。
 */
import { describe, it, expect } from 'vitest'
import { GRANULARITY_MS, MIN_DELAY_MS, nextSecondBoundaryDelay } from '../useSecondTick'

describe('nextSecondBoundaryDelay', () => {
  const anchor = 1_700_000_000_000 // 任意锚点，末尾三位的相位由取模决定

  it('I1a 触发时刻落在锚点整秒上，或因 MIN_DELAY 夹紧最多晚 MIN_DELAY_MS', () => {
    for (const elapsed of [0, 1, 230, 999, 1000, 1001, 2230, 59_999, 3_600_000]) {
      const now = anchor + elapsed
      const delay = nextSecondBoundaryDelay(now, anchor)
      const fireAt = now + delay
      // 距最近的下一个整秒边界：允许 0（精确）或 (0, MIN_DELAY_MS]（被夹紧）
      const lag = (fireAt - anchor) % GRANULARITY_MS
      expect(lag === 0 || (lag > 0 && lag <= MIN_DELAY_MS)).toBe(true)
      expect(fireAt).toBeGreaterThan(now) // 必须推进时间
    }
  })

  it('I1b 对齐是自愈的：被夹紧的偏差不会累积', () => {
    // 从最坏的相位（距边界 1ms）出发。第 1 次必然被夹紧晚到，
    // 但因为它按"实际已过时间"重算，第 2 次必须精确回到整秒。
    let now = anchor + 999
    const lags: number[] = []
    for (let i = 0; i < 6; i++) {
      now += nextSecondBoundaryDelay(now, anchor)
      lags.push((now - anchor) % GRANULARITY_MS)
    }
    expect(lags[0]).toBeGreaterThan(0)      // 第一次确实被夹紧
    expect(lags.slice(1)).toEqual([0, 0, 0, 0, 0]) // 之后每次都精确
  })

  it('I2 delay 永不为 0（含刚好落在边界上的情形）', () => {
    for (const elapsed of [0, 1000, 2000, 5000]) {
      const delay = nextSecondBoundaryDelay(anchor + elapsed, anchor)
      expect(delay).toBeGreaterThanOrEqual(MIN_DELAY_MS)
      expect(delay).toBeLessThanOrEqual(GRANULARITY_MS)
    }
  })

  it('I3 时钟回拨不产生负延迟', () => {
    expect(nextSecondBoundaryDelay(anchor - 5000, anchor)).toBe(GRANULARITY_MS)
    // 非法输入同样退化，不抛
    expect(nextSecondBoundaryDelay(Number.NaN, anchor)).toBe(GRANULARITY_MS)
  })

  it('I4 锚点相同的两个计时器，起表时刻不同也同时跳秒', () => {
    // 模拟：同一轮对话的底部徽标与折叠条分别在 +230ms / +1730ms 起表
    const simulate = (startOffset: number, ticks: number): number[] => {
      const fireTimes: number[] = []
      let now = anchor + startOffset
      for (let i = 0; i < ticks; i++) {
        const delay = nextSecondBoundaryDelay(now, anchor)
        now += delay
        fireTimes.push(now)
      }
      return fireTimes
    }
    const a = simulate(230, 8)
    const b = simulate(1730, 8)
    // b 的起点晚 1.5s ⇒ 前几个触发时刻应是 a 的子集（超出 a 的范围的不比）
    const aSet = new Set(a)
    const overlapped = b.filter((t) => aSet.has(t))
    expect(overlapped.length).toBeGreaterThanOrEqual(5)
    // 且每个触发时刻都精确落在整秒上
    for (const t of [...a, ...b]) expect((t - anchor) % GRANULARITY_MS).toBe(0)
  })
})
