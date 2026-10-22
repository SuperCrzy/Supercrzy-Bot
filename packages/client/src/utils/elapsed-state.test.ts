import { describe, it, expect } from 'vitest'
import { resolveElapsedView } from './elapsed-state'

/**
 * 断言写法说明：每条都问过"bug 存在时这个指标会不会不变"。
 * 例如「取消态优先」若被写成 `frozen` 先判，`aborted && elapsedMs` 用例会立刻退化成 done。
 */
describe('resolveElapsedView', () => {
  it('四态基线：无输入 → hidden', () => {
    expect(resolveElapsedView({})).toEqual({ state: 'hidden', ms: 0 })
  })

  it('运行中：无定格值时按起点实时算，且至少 1 秒（不出现 0s）', () => {
    expect(resolveElapsedView({ running: true, startedAt: 1000, nowMs: 1000 })).toEqual({ state: 'running', ms: 1000 })
    expect(resolveElapsedView({ running: true, startedAt: 1000, nowMs: 4200 })).toEqual({ state: 'running', ms: 3200 })
  })

  it('运行态缺起点 → hidden（没有起点就没有耗时，不显示 0s）', () => {
    expect(resolveElapsedView({ running: true, nowMs: 5000 })).toEqual({ state: 'hidden', ms: 0 })
  })

  it('已完成：有定格值即 done，且忽略实时值（不会被 nowMs 拖长）', () => {
    expect(resolveElapsedView({ elapsedMs: 7000, startedAt: 1000, nowMs: 99999, running: false }))
      .toEqual({ state: 'done', ms: 7000 })
  })

  it('运行中被写入定格值 → done（先算完再收尾，不能继续说"进行中"）', () => {
    expect(resolveElapsedView({ elapsedMs: 3000, running: true, startedAt: 1000, nowMs: 9000 }))
      .toEqual({ state: 'done', ms: 3000 })
  })

  it('取消态优先于完成态：既有中止标记又有定格值 → aborted', () => {
    expect(resolveElapsedView({ aborted: true, elapsedMs: 7000, running: false }))
      .toEqual({ state: 'aborted', ms: 7000 })
  })

  it('取消态且无定格值 → 用起点算，仍至少 1 秒（点停止瞬间不留空）', () => {
    expect(resolveElapsedView({ aborted: true, startedAt: 1000, nowMs: 1250 }))
      .toEqual({ state: 'aborted', ms: 1000 })
    expect(resolveElapsedView({ aborted: true, startedAt: 1000, nowMs: 6250 }))
      .toEqual({ state: 'aborted', ms: 5250 })
  })

  it('取消态连起点都没有 → aborted 1s，绝不退回 hidden（否则徽标整块消失就是原 bug）', () => {
    expect(resolveElapsedView({ aborted: true })).toEqual({ state: 'aborted', ms: 1000 })
  })

  it('elapsedMs 为 0 或负数视为无定格值（0 是"没写"不是"瞬间完成"）', () => {
    expect(resolveElapsedView({ elapsedMs: 0, running: false })).toEqual({ state: 'hidden', ms: 0 })
    expect(resolveElapsedView({ elapsedMs: -5, running: false })).toEqual({ state: 'hidden', ms: 0 })
  })

  it('非法输入不抛：nowMs 非数字 → 归到 1 秒，不显示 NaN', () => {
    const v = resolveElapsedView({ running: true, startedAt: 1000, nowMs: NaN as unknown as number })
    expect(v.state).toBe('running')
    expect(v.ms).toBe(1000)
    expect(Number.isFinite(v.ms)).toBe(true)
  })
})
