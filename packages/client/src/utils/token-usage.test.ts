import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  fillEstimatedTokens,
  fillMeasuredTokens,
  formatTokenCount,
  TOKENS_PER_CHAR,
} from './token-usage'

const codePoints = (s: string) => Array.from(s).length

describe('估算系数', () => {
  it('按字符数 × 0.6 向上取整', () => {
    expect(estimateTokens(100)).toBe(Math.ceil(100 * TOKENS_PER_CHAR))
    expect(estimateTokens(100)).toBe(60)
    expect(estimateTokens(1)).toBe(1)
  })

  it('非法/零输入返回 0，不产生 NaN', () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(-5)).toBe(0)
    expect(estimateTokens(Number.NaN)).toBe(0)
  })
})

describe('fillEstimatedTokens', () => {
  it('无真值时写入估算并打标记', () => {
    const msg: any = { content: 'x' }
    expect(fillEstimatedTokens(msg, 100)).toBe(true)
    expect(msg.tokenCount).toBe(60)
    expect(msg.tokenEstimated).toBe(true)
  })

  it('🔴 已有真值时绝不覆盖（真值不可被估算顶掉）', () => {
    const msg: any = { tokenCount: 1234, tokenEstimated: false }
    expect(fillEstimatedTokens(msg, 999999)).toBe(false)
    expect(msg.tokenCount).toBe(1234)
    expect(msg.tokenEstimated).toBe(false)
  })

  it('字符数为 0 时不写 0 也不打标记（避免显示 "~0 tokens"）', () => {
    const msg: any = {}
    expect(fillEstimatedTokens(msg, 0)).toBe(false)
    expect(msg.tokenCount).toBeUndefined()
    expect(msg.tokenEstimated).toBeUndefined()
  })
})

describe('fillMeasuredTokens', () => {
  it('写入真值并清掉估算标记', () => {
    const msg: any = { tokenCount: 60, tokenEstimated: true }
    expect(fillMeasuredTokens(msg, 4321)).toBe(true)
    expect(msg.tokenCount).toBe(4321)
    expect(msg.tokenEstimated).toBe(false)
  })

  it('真值为 0/undefined 时不写入（不把已有估算清成空）', () => {
    const msg: any = { tokenCount: 60, tokenEstimated: true }
    expect(fillMeasuredTokens(msg, 0)).toBe(false)
    expect(fillMeasuredTokens(msg, undefined)).toBe(false)
    expect(msg.tokenCount).toBe(60)
    expect(msg.tokenEstimated).toBe(true)
  })
})

describe('formatTokenCount：估算必须可见', () => {
  it('估算值带 ~ 前缀', () => {
    expect(formatTokenCount({ tokenCount: 60, tokenEstimated: true })).toBe('~60')
  })

  it('真值不加前缀', () => {
    expect(formatTokenCount({ tokenCount: 60, tokenEstimated: false })).toBe('60')
    expect(formatTokenCount({ tokenCount: 60 })).toBe('60')
  })

  it('无值返回空串', () => {
    expect(formatTokenCount({})).toBe('')
    expect(formatTokenCount({ tokenCount: 0 })).toBe('')
  })
})

describe('🔴 端到端：同一轮对话里 估算 → 真值 的顺序不影响结果', () => {
  it('先估算后真值 ⇒ 最终是真值且无标记', () => {
    const msg: any = {}
    fillEstimatedTokens(msg, 500)
    fillMeasuredTokens(msg, 812)
    expect(msg.tokenCount).toBe(812)
    expect(msg.tokenEstimated).toBe(false)
  })

  it('先真值后估算 ⇒ 估算被拒，仍是真值', () => {
    const msg: any = {}
    fillMeasuredTokens(msg, 812)
    fillEstimatedTokens(msg, 500)
    expect(msg.tokenCount).toBe(812)
    expect(msg.tokenEstimated).toBe(false)
  })

  it('只有估算 ⇒ 标记为真（UI 会显示 ~）', () => {
    const msg: any = {}
    fillEstimatedTokens(msg, 500)
    expect(msg.tokenEstimated).toBe(true)
    expect(formatTokenCount(msg)).toBe('~300')
  })
})

describe('与 ChatView 的字符口径一致', () => {
  it('按字符（码点）计，不按字节', () => {
    const zh = '中文五个字'
    expect(codePoints(zh)).toBe(5)
    expect(estimateTokens(codePoints(zh))).toBe(3)
  })
})
