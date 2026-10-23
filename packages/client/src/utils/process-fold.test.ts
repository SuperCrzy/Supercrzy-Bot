import { describe, it, expect } from 'vitest'
import { shouldFoldProcess, INLINE_PROCESS_MAX_STEPS, INLINE_PROCESS_MAX_NODES } from './process-fold'

describe('shouldFoldProcess 自适应折叠规则', () => {
  it('短任务不折叠：≤ 阈值步数直接平铺（证据要看得见）', () => {
    for (let s = 1; s <= INLINE_PROCESS_MAX_STEPS; s++) {
      expect(shouldFoldProcess(s, s)).toBe(false)
    }
  })

  it('超过阈值才折叠', () => {
    expect(shouldFoldProcess(INLINE_PROCESS_MAX_STEPS + 1, INLINE_PROCESS_MAX_STEPS + 1)).toBe(true)
    expect(shouldFoldProcess(12, 25)).toBe(true)
  })

  it('纯聊天（0 步）没有过程可折 → 不折叠', () => {
    expect(shouldFoldProcess(0, 0)).toBe(false)
    expect(shouldFoldProcess(0, 2)).toBe(false)
  })

  it('步数少但过程节点刷屏（思考极多）→ 仍然折叠', () => {
    expect(shouldFoldProcess(2, INLINE_PROCESS_MAX_NODES + 1)).toBe(true)
    // 边界：正好等于上限时不折叠
    expect(shouldFoldProcess(2, INLINE_PROCESS_MAX_NODES)).toBe(false)
  })
})
