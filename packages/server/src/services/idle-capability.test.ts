/**
 * G3 闲置能力建议契约测试（2026-10-23）。
 *
 * 验收断言（backlog G3）：
 * ① 当天新装的 skill 不推；
 * ② dismiss v1 后 v2 提醒仍出现；
 * ③ 对 16 个从未调用的工具能算出闲置天数并给出建议。
 */
import { describe, it, expect } from 'vitest'
import { computeIdleSuggestions, capabilityVersion, type DismissRecord } from './idle-capability'

const TODAY = '2026-10-23'
const OBS_START = '2026-08-01'

const CATALOG_16 = [
  'file_delete', 'generate_image', 'get_goal', 'git_commit', 'make_article',
  'memory_consolidate', 'multi_edit', 'skill_install', 'skill_search',
  'task_create', 'terminal_close', 'terminal_list', 'terminal_open',
  'terminal_read', 'terminal_send', 'terminal_signal',
].map((name) => ({ name, description: `${name} test` }))

function baseInput(over: Partial<Parameters<typeof computeIdleSuggestions>[0]> = {}) {
  return {
    today: TODAY,
    catalog: CATALOG_16,
    usage: [{ toolsUsed: ['shell_exec'], date: OBS_START }],
    version: capabilityVersion(CATALOG_16),
    ...over,
  }
}

describe('idle-capability', () => {
  it('③ 16 个从未调用的工具全部得出 never-used 建议且闲置天数 = 观测起点起算', () => {
    const { suggestions, idleDays } = computeIdleSuggestions(baseInput())
    expect(suggestions).toHaveLength(16)
    expect(suggestions.every((s) => s.reason === 'never-used')).toBe(true)
    expect(suggestions.every((s) => s.idleDays === 83)).toBe(true) // 10-23 − 08-01
    expect(idleDays['multi_edit']).toBe(83)
  })

  it('③ 有用过的工具按 lastUsed 起算（≥14 天才推）', () => {
    const { suggestions, idleDays } = computeIdleSuggestions(baseInput({
      usage: [
        { toolsUsed: ['shell_exec'], date: OBS_START },
        { toolsUsed: ['multi_edit'], date: '2026-10-20' },   // 3 天前 → 不推
        { toolsUsed: ['get_goal'], date: '2026-09-01' },     // 52 天前 → 推，reason=idle
      ],
    }))
    expect(suggestions.find((s) => s.tool === 'multi_edit')).toBeUndefined()
    const goal = suggestions.find((s) => s.tool === 'get_goal')
    expect(goal?.reason).toBe('idle')
    expect(goal?.idleDays).toBe(52)
    expect(idleDays['multi_edit']).toBe(3)
    expect(suggestions).toHaveLength(15) // 16 − multi_edit
  })

  it('① 当天新装（firstSeen = today）不推', () => {
    const { suggestions } = computeIdleSuggestions(baseInput({
      firstSeen: { skill_install: TODAY, skill_search: TODAY },
    }))
    expect(suggestions.find((s) => s.tool === 'skill_install')).toBeUndefined()
    expect(suggestions.find((s) => s.tool === 'skill_search')).toBeUndefined()
    expect(suggestions).toHaveLength(14)
  })

  it('② dismiss 后同版本不推；版本变（v2）后重新出现', () => {
    const v1 = capabilityVersion(CATALOG_16)
    const dismissed: DismissRecord[] = [{ tool: 'git_commit', version: v1 }]
    const noSuggest = computeIdleSuggestions(baseInput({ dismissed }))
    expect(noSuggest.suggestions.find((s) => s.tool === 'git_commit')).toBeUndefined()
    // v2：目录描述变化 → 版本变 → 旧 dismiss 失效，重新出现
    const catalogV2 = CATALOG_16.map((t) => t.name === 'git_commit' ? { ...t, description: 'git_commit v2 desc' } : t)
    const v2 = capabilityVersion(catalogV2)
    expect(v2).not.toBe(v1)
    const reSuggest = computeIdleSuggestions(baseInput({ catalog: catalogV2, version: v2, dismissed }))
    expect(reSuggest.suggestions.find((s) => s.tool === 'git_commit')).toBeDefined()
    // 其它工具的 dismiss 不影响 git_commit（同版本内只挡自己）
    const dismissedOther = computeIdleSuggestions(baseInput({ dismissed: [{ tool: 'file_delete', version: v1 }] }))
    expect(dismissedOther.suggestions.find((s) => s.tool === 'git_commit')).toBeDefined()
  })

  it('capabilityVersion 稳定且对描述变化敏感', () => {
    expect(capabilityVersion(CATALOG_16)).toBe(capabilityVersion([...CATALOG_16].reverse()))
    expect(capabilityVersion(CATALOG_16)).not.toBe(capabilityVersion(CATALOG_16.slice(0, 15)))
  })
})
