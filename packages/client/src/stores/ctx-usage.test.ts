/**
 * 上下文用量清零（2026-10-22，B 项）
 *
 * 修掉的问题：`ctxUsed` 是全局 ref，只在 `usage` 事件到达时被写，**切会话不清零**。
 * 打开一个新会话时顶部环还挂着上个会话的"已用上下文"，百分比与真实占用无关。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from './app'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('resetCtxUsage', () => {
  it('把已用上下文与压缩时间标记一起清掉', () => {
    const app = useAppStore()
    app.setCtxUsage(468_671)
    app.markCtxCompressed()
    expect(app.ctxUsed).toBe(468_671)
    expect(app.ctxCompressedAt).not.toBeNull()

    app.resetCtxUsage()

    expect(app.ctxUsed).toBe(0)
    expect(app.ctxCompressedAt).toBeNull()
  })

  it('🔴 不清窗口大小（模型没变，清了会闪回默认 128K）', () => {
    const app = useAppStore()
    app.setCtxWindow(1_048_576)
    app.setCtxUsage(100_000)

    app.resetCtxUsage()

    expect(app.ctxWindow).toBe(1_048_576)
  })

  it('本身就是 0 时清零不报错（幂等）', () => {
    const app = useAppStore()
    expect(() => app.resetCtxUsage()).not.toThrow()
    expect(() => app.resetCtxUsage()).not.toThrow()
    expect(app.ctxUsed).toBe(0)
  })
})

describe('setCtxWindow 守卫', () => {
  it('非正数不覆盖当前窗口（避免分母变 0 导致百分比 NaN）', () => {
    const app = useAppStore()
    app.setCtxWindow(1_048_576)
    app.setCtxWindow(0)
    app.setCtxWindow(-1)
    expect(app.ctxWindow).toBe(1_048_576)
  })
})
