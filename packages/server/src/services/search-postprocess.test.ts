import { describe, it, expect } from 'vitest'
import { postProcessSearchResults } from './tools'

describe('postProcessSearchResults 时效过滤（2026-08-25 修复）', () => {
  // 注意：一律基于真实 Date.now() 相对计算（函数内部用 Date.now()，不能用假时钟）
  const HOUR = 3600e3
  const DAY = 24 * HOUR
  const mk = (title: string, date?: string) => ({ title, url: `https://${title}.com/x`, description: 'x', date })

  it('有合格日期的前置、无日期降权排尾（旧闻不再混在前列）', () => {
    const results = [
      mk('old-undated'),                          // 无日期 → 应排尾
      mk('yesterday', new Date(Date.now() - 20 * HOUR).toISOString()),  // 20h 前 → 合格
      mk('old-dated', new Date(Date.now() - 5 * DAY).toISOString()),    // 5 天前 → 超期剔除
    ]
    const out = postProcessSearchResults(results, 10, 1) // day=1 天窗口
    expect(out.map((r) => r.title)).toEqual(['yesterday', 'old-undated'])
  })

  it('超期日期剔除 + 无日期保留但排尾', () => {
    const results = [
      mk('a', new Date(Date.now() - 30 * HOUR).toISOString()), // 30h 前 → 超期剔除
      mk('b'),                                                 // 无日期 → 保留排尾
    ]
    const out = postProcessSearchResults(results, 10, 1)
    expect(out.map((r) => r.title)).toEqual(['b'])
  })

  it('全超期时返回空结果（宁可空手，不让旧闻混入"今天"）', () => {
    const results = [mk('x', new Date(Date.now() - 10 * DAY).toISOString())]
    const out = postProcessSearchResults(results, 10, 1)
    expect(out.length).toBe(0)
  })

  it('maxAgeDays=0 时不过滤（原样保留）', () => {
    const results = [mk('a', new Date(Date.now() - 99 * DAY).toISOString()), mk('b')]
    const out = postProcessSearchResults(results, 10, 0)
    expect(out.length).toBe(2)
  })

  it('排序：新鲜度优先，无效日期按 0 处理排最后', () => {
    const results = [
      mk('invalid', 'garbage-date'),
      mk('fresh', new Date(Date.now() - HOUR).toISOString()),
      mk('older', new Date(Date.now() - 48 * HOUR).toISOString()),
    ]
    const out = postProcessSearchResults(results, 10, 0)
    expect(out.map((r) => r.title)).toEqual(['fresh', 'older', 'invalid'])
  })
})
