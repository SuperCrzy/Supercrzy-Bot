import { describe, it, expect } from 'vitest'
import { deriveCollapseState, collapseStateToField, type CollapseSignal } from './fold-state'

/** 构造信号辅助（默认全 false = 流式初始态） */
function sig(over: Partial<CollapseSignal> = {}): CollapseSignal {
  return { textStarted: false, hasEnd: false, foldTimerElapsed: false, ...over }
}

describe('deriveCollapseState 折叠状态机（2026-08-25 重构）', () => {
  it('初始态（无正文无结束）→ auto（流式平铺）', () => {
    expect(deriveCollapseState(sig())).toBe('auto')
  })

  it('正文开始但 800ms 延迟未触发 → auto（等确认，不立即折）', () => {
    expect(deriveCollapseState(sig({ textStarted: true }))).toBe('auto')
  })

  it('正文开始 + 延迟确认触发 → auto（2026-08-26 修复：中途不再折叠，避免"文字/工具交替→折展开→框反复伸缩"）', () => {
    expect(deriveCollapseState(sig({ textStarted: true, foldTimerElapsed: true }))).toBe('auto')
  })

  it('工具间说明被新工具打断（textStarted 但 foldTimerElapsed=false）→ auto（不误折叠，坑③）', () => {
    expect(deriveCollapseState(sig({ textStarted: true, foldTimerElapsed: false }))).toBe('auto')
  })

  it('流结束 hasEnd → folded（唯一中途/收尾折叠依据；8-26 修复后折叠只在 done 那刻发生一次）', () => {
    expect(deriveCollapseState(sig({ textStarted: false, hasEnd: true }))).toBe('folded')
  })

  it('用户手动展开 → expanded（即使 hasEnd 也不覆盖）', () => {
    expect(deriveCollapseState(sig({ hasEnd: true, userOverride: 'expanded' }))).toBe('expanded')
  })

  it('用户手动折叠 → folded（最高优先）', () => {
    expect(deriveCollapseState(sig({ userOverride: 'folded' }))).toBe('folded')
  })

  it('卡死工具节点不影响判定：状态机只看信号不看工具状态（坑①——并行工具 result 丢失场景由外部 flow 更新，此处信号即判定全部依据；8-26 后折叠只看 hasEnd）', () => {
    // 模拟：正文已开始 + 延迟确认触发（无论 flow 里工具节点是否卡 running）→ 流式中仍平铺（auto），done 才折
    expect(deriveCollapseState(sig({ textStarted: true, foldTimerElapsed: true }))).toBe('auto')
    expect(deriveCollapseState(sig({ textStarted: true, foldTimerElapsed: true, hasEnd: true }))).toBe('folded')
  })

  it('collapseStateToField 映射：folded→true / expanded→false / auto→undefined', () => {
    expect(collapseStateToField('folded')).toBe(true)
    expect(collapseStateToField('expanded')).toBe(false)
    expect(collapseStateToField('auto')).toBeUndefined()
  })
})
