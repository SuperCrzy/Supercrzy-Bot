/**
 * 三档权限映射单测（P0-04）
 * 重点验证：收敛到三档后**行为不放宽**，且历史配置能被正确投影。
 */
import { describe, it, expect } from 'vitest'
import {
  resolvePermissionTier,
  tierToLegacyMode,
  resolveApprovalMode,
  isPermissionTier,
  PERMISSION_TIERS,
  TIER_META,
} from './permission'

describe('三档定义', () => {
  it('恰好三档，顺序为 readonly → ask → auto', () => {
    expect(PERMISSION_TIERS).toEqual(['readonly', 'ask', 'auto'])
  })

  it('每档都有名称、说明与内部映射', () => {
    for (const t of PERMISSION_TIERS) {
      expect(TIER_META[t].label.length).toBeGreaterThan(0)
      expect(TIER_META[t].description.length).toBeGreaterThan(0)
      expect(['auto', 'accept-edits', 'prompt', 'deny']).toContain(TIER_META[t].legacy)
    }
  })

  it('类型守卫', () => {
    expect(isPermissionTier('ask')).toBe(true)
    expect(isPermissionTier('accept-edits')).toBe(false)
    expect(isPermissionTier(null)).toBe(false)
  })
})

describe('历史 4 档 → 三档投影', () => {
  it('deny → readonly', () => {
    expect(resolvePermissionTier('deny')).toBe('readonly')
  })
  it('prompt → ask', () => {
    expect(resolvePermissionTier('prompt')).toBe('ask')
  })
  it('accept-edits → ask（问得更多，不放宽）', () => {
    expect(resolvePermissionTier('accept-edits')).toBe('ask')
  })
  it('auto → auto', () => {
    expect(resolvePermissionTier('auto')).toBe('auto')
  })
  it('未配置时按会话权限档兜底', () => {
    expect(resolvePermissionTier(null, 'workspace-only')).toBe('readonly')
    expect(resolvePermissionTier(null, 'sandbox')).toBe('ask')
    expect(resolvePermissionTier(null, 'full')).toBe('auto')
    expect(resolvePermissionTier(undefined, undefined)).toBe('ask')
  })
})

describe('三档 → 内部档位', () => {
  it('映射到对应历史档位', () => {
    expect(tierToLegacyMode('readonly')).toBe('deny')
    expect(tierToLegacyMode('ask')).toBe('prompt')
    expect(tierToLegacyMode('auto')).toBe('auto')
  })
})

describe('resolveApprovalMode（最终生效档位）', () => {
  it('三档设置优先于历史四档', () => {
    expect(resolveApprovalMode('readonly', 'auto')).toBe('deny')
    expect(resolveApprovalMode('ask', 'auto')).toBe('prompt')
    expect(resolveApprovalMode('auto', 'deny')).toBe('auto')
  })

  it('无三档设置时回退历史四档（老配置不被破坏，含 accept-edits）', () => {
    expect(resolveApprovalMode(undefined, 'accept-edits')).toBe('accept-edits')
    expect(resolveApprovalMode(null, 'deny')).toBe('deny')
    expect(resolveApprovalMode('', 'auto')).toBe('auto')
  })

  it('两者都无 → 按会话权限档推导', () => {
    expect(resolveApprovalMode(undefined, undefined, 'workspace-only')).toBe('deny')
    expect(resolveApprovalMode(undefined, undefined, 'full')).toBe('auto')
    expect(resolveApprovalMode(undefined, undefined, 'sandbox')).toBe('prompt')
  })

  it('非法三档值被忽略，回退历史档（不因脏数据放宽权限）', () => {
    expect(resolveApprovalMode('hacker-mode', 'deny')).toBe('deny')
    expect(resolveApprovalMode('hacker-mode', undefined, 'workspace-only')).toBe('deny')
  })

  it('收敛方向安全：readonly 档在任何历史配置下都不放行', () => {
    for (const legacy of ['auto', 'accept-edits', 'prompt', 'deny', undefined]) {
      expect(resolveApprovalMode('readonly', legacy as any)).toBe('deny')
    }
  })
})
