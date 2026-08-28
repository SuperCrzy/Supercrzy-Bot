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
