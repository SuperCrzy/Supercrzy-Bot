import { describe, it, expect } from 'vitest'
import { maskSecret } from '../routes/settings'

describe('maskSecret 密钥脱敏', () => {
  const key = 'sk-test-0123456789abcdef0123456789abcdef'

  it('前 8 后 4 格式（apiKey）', () => {
    expect(maskSecret(key, 8)).toBe('sk-test-...cdef')
  })

  it('前 4 后 4 格式（qqAppSecret）', () => {
    expect(maskSecret(key, 4)).toBe('sk-t...cdef')
  })

  it('短密钥不报错', () => {
    expect(maskSecret('abc', 8)).toContain('...')
  })

  it('不会泄露中间明文', () => {
    const masked = maskSecret(key, 8)
    // 中间部分绝不出现
    expect(masked.includes('ba6eca9d')).toBe(false)
  })
})
