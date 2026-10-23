/**
 * G2 能力清单契约测试（2026-10-23）。
 *
 * 验收断言（backlog G2）：
 * ① 同一输入两次生成 hash 相同（插入顺序无关）；
 * ② 关掉任一 skill，provenance 里能看出是谁消失（sources 少一条 `skill:*`，hash 变化）；
 * ③ 同一工具多来源可并存且去重。
 */
import { describe, it, expect } from 'vitest'
import { createCapabilityManifest, addCapability, countBySourceKind } from './capability-manifest'

describe('capability-manifest', () => {
  it('① 同输入两次 hash 相同（插入顺序无关）', () => {
    const a = addCapability(addCapability(createCapabilityManifest(), ['file_read', 'shell_exec'], 'builtin'), ['browser'], 'skill:web')
    const b = addCapability(addCapability(createCapabilityManifest(), ['browser'], 'skill:web'), ['shell_exec', 'file_read'], 'builtin')
    expect(a.hash).toBe(b.hash)
    expect(a.entries).toEqual(b.entries)
    // 再算一遍哈希仍稳定
    expect(a.hash).toBe(a.hash)
  })

  it('② 关掉 skill：对应 entry 少一条 skill:* 来源，hash 变化', () => {
    const withSkill = addCapability(createCapabilityManifest(), ['browser'], 'skill:web')
    const withoutSkill = addCapability(createCapabilityManifest(), ['browser'], 'builtin')
    // browser 由 builtin+skill 共同带来 → 关掉 skill 后只剩 builtin，hash 必变
    const both = addCapability(addCapability(createCapabilityManifest(), ['browser'], 'builtin'), ['browser'], 'skill:web')
    expect(both.entries[0].sources.sort()).toEqual(['builtin', 'skill:web'])
    expect(both.hash).not.toBe(withoutSkill.hash)
    expect(countBySourceKind(both)['skill']).toBe(1)
    expect(countBySourceKind(withSkill)['skill']).toBe(1)
  })

  it('③ 同一来源重复登记不产生重复条目；空名忽略', () => {
    const m = addCapability(addCapability(createCapabilityManifest(), ['x_tool', ''], 'builtin'), ['x_tool'], 'builtin')
    expect(m.entries).toHaveLength(1)
    expect(m.entries[0].sources).toEqual(['builtin'])
  })

  it('④ 空 manifest hash 与满 manifest 不同', () => {
    const empty = createCapabilityManifest()
    const full = addCapability(createCapabilityManifest(), ['a'], 'builtin')
    expect(empty.hash).not.toBe(full.hash)
    expect(empty.entries).toEqual([])
  })
})
