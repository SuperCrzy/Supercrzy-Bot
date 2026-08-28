import { describe, it, expect } from 'vitest'
import { canContinue } from './deep-research'

// ---- 2026-08-28：修复"深度研究卡死"——预算刹车 ----
// 旧实现 breadth=4/depth=2 结构展开为 20 次搜索 + 33 次 LLM、最坏 ~23 分钟，
// 用户只看到进度条"一直在深度思考"。新增全局搜索预算 + 整体硬超时，
// canContinue() 是唯一判据，这里锁死其语义。
describe('deepResearch 预算防线 canContinue()', () => {
  it('预算未满、未超时、未中止 → 可继续', () => {
    const b = { queriesUsed: 0, maxQueryBudget: 24, deadline: Date.now() + 300000, aborted: false, lateStarters: false }
    expect(canContinue(b)).toBe(true)
  })

  it('查询预算用尽 → 刹车（不再派发新搜索）', () => {
    const b = { queriesUsed: 24, maxQueryBudget: 24, deadline: Date.now() + 300000, aborted: false, lateStarters: false }
    expect(canContinue(b)).toBe(false)
  })

  it('整体超时 → 刹车（用已收集信息收尾而非无限等）', () => {
    const b = { queriesUsed: 1, maxQueryBudget: 24, deadline: Date.now() - 1, aborted: false, lateStarters: false }
    expect(canContinue(b)).toBe(false)
  })

  it('被中止 → 刹车', () => {
    const b = { queriesUsed: 0, maxQueryBudget: 24, deadline: Date.now() + 300000, aborted: true, lateStarters: false }
    expect(canContinue(b)).toBe(false)
  })

  it('预算用尽后即使恢复 deadline 也保持刹车（中止优先于时间）', () => {
    // lateStarters 场景：预算先耗尽，绝不允许后续层再生成新查询
    const b = { queriesUsed: 24, maxQueryBudget: 24, deadline: Date.now() + 999999, aborted: false, lateStarters: false }
    expect(canContinue(b)).toBe(false)
  })
})
