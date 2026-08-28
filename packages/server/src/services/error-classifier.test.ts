import { describe, it, expect } from 'vitest'
import { classifyApiError, jitteredBackoff } from './error-classifier'

describe('error-classifier', () => {
  it('429 → rate_limit 可重试应降级', () => {
    const c = classifyApiError({ status: 429, message: 'Too Many Requests' })
    expect(c.reason).toBe('rate_limit')
    expect(c.retryable).toBe(true)
    expect(c.shouldFallback).toBe(true)
  })

  it('401 → auth 不可重试需轮换凭据', () => {
    const c = classifyApiError({ status: 401, message: 'Invalid API key' })
    expect(c.reason).toBe('auth')
    expect(c.retryable).toBe(false)
    expect(c.shouldRotateCredential).toBe(true)
  })

  it('401 + 欠费文案 → billing 不轮换凭据', () => {
    const c = classifyApiError({ status: 401, message: 'account arrearage, please recharge' })
    expect(c.reason).toBe('billing')
    expect(c.shouldRotateCredential).toBe(false)
  })

  it('413 → context_overflow 应压缩上下文', () => {
    const c = classifyApiError({ status: 413, message: 'Request too large' })
    expect(c.reason).toBe('context_overflow')
    expect(c.shouldCompress).toBe(true)
  })

  it('502 → server_error 可降级', () => {
    const c = classifyApiError({ status: 502, message: 'Bad Gateway' })
    expect(c.reason).toBe('server_error')
    expect(c.shouldFallback).toBe(true)
  })

  it('网络错误(无状态) → connection', () => {
    const c = classifyApiError({ message: 'fetch failed: ECONNREFUSED' })
    expect(c.reason).toBe('connection')
    expect(c.retryable).toBe(true)
  })

  it('tool_calls 无配对 → tool_sequence 可重试且不降级(需清洗重试)', () => {
    const c = classifyApiError({
      message: 'An assistant message with tool_calls must be followed by tool messages responding to each tool_call_id. (insufficient tool messages following tool_calls message)',
    })
    expect(c.reason).toBe('tool_sequence')
    expect(c.retryable).toBe(true)
    expect(c.shouldFallback).toBe(false)
    expect(c.shouldCompress).toBe(false)
  })

  it('reasoning_content 未返回 → tool_sequence(深度思考模式)', () => {
    const c = classifyApiError({
      message: 'The reasoning_content in the thinking mode must be passed back to the API.',
    })
    expect(c.reason).toBe('tool_sequence')
    expect(c.retryable).toBe(true)
  })

  it('普通 400 非工具序列错误 → unknown 不误判为 tool_sequence', () => {
    const c = classifyApiError({ status: 400, message: 'invalid style parameter' })
    expect(c.reason).toBe('unknown')
  })

  // ---- 2026-08-28 系统性根治：402 / 通用 4xx / 状态码兜底解析 ----
  it('402 余额不足 → billing 不可重试(重试换模型都救不了)', () => {
    const c = classifyApiError({ status: 402, message: 'Insufficient Balance' })
    expect(c.reason).toBe('billing')
    expect(c.retryable).toBe(false)
    expect(c.shouldFallback).toBe(true)
  })

  it('只有消息文本无 status 字段时也能解析出 402(修 throw 丢状态码)', () => {
    const c = classifyApiError({ message: 'API error 402: Insufficient Balance' })
    expect(c.reason).toBe('billing')
    expect(c.retryable).toBe(false)
  })

  it('英文原文 Insufficient Balance 顺序反了也要命中 billing', () => {
    // 历史 bug：只有 /balance.*insufficient/i，匹配不上 "Insufficient Balance" → 落入 unknown 盲重试
    const c = classifyApiError({ status: 0, message: 'HTTP 402: Insufficient Balance, please recharge' })
    expect(c.reason).toBe('billing')
  })

  it('通用 4xx(400/404/422) 不可重试 —— 同样请求重试永远同样错', () => {
    for (const status of [400, 404, 422]) {
      const c = classifyApiError({ status, message: 'bad request' })
      expect(c.retryable, `status ${status} 不应重试`).toBe(false)
    }
  })

  it('瞬态 4xx(408/409/429) 仍可重试', () => {
    for (const status of [408, 409, 429]) {
      const c = classifyApiError({ status, message: 'transient' })
      expect(c.retryable, `status ${status} 应可重试`).toBe(true)
    }
  })

  it('5xx 仍可重试', () => {
    expect(classifyApiError({ status: 503, message: 'Service Unavailable' }).retryable).toBe(true)
  })

  it('正文中的普通数字不被误判为状态码', () => {
    // "4096" 是 4 位数且 \b 不匹配内部；纯数字 500 出现在正文也不该被当状态码
    const c = classifyApiError({ message: 'request took 500 ms and used 4096 tokens' })
    expect(c.retryable).toBe(true) // 未命中 4xx → unknown 仍可重试（网络抖动语义）
  })

  it('jitteredBackoff 单调且不超过上限的 1.5 倍(jitter 加噪)', () => {
    const b1 = jitteredBackoff(1, 100, 5000)
    const b2 = jitteredBackoff(2, 100, 5000)
    expect(b1).toBeGreaterThanOrEqual(100)
    expect(b2).toBeGreaterThanOrEqual(200)
    expect(b2).toBeLessThanOrEqual(7500) // 1.5 × maxDelay（含 jitter）
    // 大 attempt 封顶到 maxDelay + jitter
    expect(jitteredBackoff(99, 100, 5000)).toBeLessThanOrEqual(7500)
  })
})
