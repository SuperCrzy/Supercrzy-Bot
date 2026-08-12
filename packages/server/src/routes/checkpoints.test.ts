import { describe, it, expect } from 'vitest'
import { isValidCheckpointId, UUID_RE } from '../routes/checkpoints'

describe('checkpoint ID 校验（防路径穿越）', () => {
  it('合法 UUID 通过', () => {
    expect(isValidCheckpointId('ffc412d1-0a95-474a-ac92-f31c9aca4240')).toBe(true)
    expect(UUID_RE.test('FFC412D1-0A95-474A-AC92-F31C9ACA4240')).toBe(true) // 大小写不敏感
  })

  it('路径穿越写法被拒', () => {
    expect(isValidCheckpointId('../etc/passwd')).toBe(false)
    expect(isValidCheckpointId('..%2F..%2Fetc')).toBe(false)
    expect(isValidCheckpointId('../../etc')).toBe(false)
  })

  it('非 UUID 格式被拒', () => {
    expect(isValidCheckpointId('abc')).toBe(false)
    expect(isValidCheckpointId('ffc412d1')).toBe(false)
    expect(isValidCheckpointId('not-a-uuid')).toBe(false)
  })

  it('空串/undefined 被拒', () => {
    expect(isValidCheckpointId('')).toBe(false)
    expect(isValidCheckpointId(undefined as unknown as string)).toBe(false)
  })
})
