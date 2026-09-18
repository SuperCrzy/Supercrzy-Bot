/**
 * memory-category.ts 回归测试（#147 记忆分类收敛，2026-09-18）
 *
 * 为什么值得单测：这个文件是**分类词表的唯一权威**，它错了会同时污染
 *   ① 所有写入路径落库的分类值  ② 排序权重  ③ database.ts 的历史数据迁移。
 * 而这三个后果都不会立刻报错，只会表现为"记忆注进去的顺序莫名其妙"——正是本次要修的病，
 * 所以在这里把词表、别名、权重、归一行为全部锁死。
 */
import { describe, it, expect } from 'vitest'
import {
  MEMORY_CATEGORIES,
  CATEGORY_ALIASES,
  CATEGORY_WEIGHT,
  DEFAULT_CATEGORY,
  normalizeCategory,
  categoryWeight,
  isMemoryCategory,
  normalizeImportance,
} from './memory-category'

describe('MEMORY_CATEGORIES 现行枚举', () => {
  it('恰好 7 个分类，且含被历史遗漏的 preference / rule', () => {
    expect(MEMORY_CATEGORIES).toHaveLength(7)
    expect([...MEMORY_CATEGORIES].sort()).toEqual(
      ['experience', 'general', 'knowledge', 'preference', 'rule', 'topic', 'user'].sort(),
    )
  })

  it('已废弃的 fact 不在枚举里（历史值靠别名折算，不再当活分类）', () => {
    expect(MEMORY_CATEGORIES as readonly string[]).not.toContain('fact')
    expect(DEFAULT_CATEGORY).toBe('general')
  })

  it('权重表覆盖每一个枚举项（不漏项 → 不会退化成 ?? 1.0 默认值）', () => {
    for (const c of MEMORY_CATEGORIES) {
      expect(CATEGORY_WEIGHT[c], `缺权重: ${c}`).toBeTypeOf('number')
    }
    expect(Object.keys(CATEGORY_WEIGHT).sort()).toEqual([...MEMORY_CATEGORIES].sort())
  })
})

describe('CATEGORY_WEIGHT 排序权重（只加不削）', () => {
  it('改动前已有分类的原值一个都没动', () => {
    // 这三个是历史值，若被"顺手优化"会让既有行为不可预期地退化
    expect(CATEGORY_WEIGHT.experience).toBe(1.5)
    expect(CATEGORY_WEIGHT.user).toBe(1.3)
    expect(CATEGORY_WEIGHT.knowledge).toBe(1.0)
    expect(CATEGORY_WEIGHT.general).toBe(0.8)
  })

  it('preference / rule 高于 experience（低频高信噪的要压过高频膨胀的）', () => {
    expect(CATEGORY_WEIGHT.preference).toBeGreaterThan(CATEGORY_WEIGHT.experience)
    expect(CATEGORY_WEIGHT.rule).toBeGreaterThanOrEqual(CATEGORY_WEIGHT.experience)
  })

  it('preference 是最高权重（个性化最关键）', () => {
    const max = Math.max(...Object.values(CATEGORY_WEIGHT))
    expect(CATEGORY_WEIGHT.preference).toBe(max)
  })
})

describe('normalizeCategory 归一', () => {
  it('合法值原样返回', () => {
    for (const c of MEMORY_CATEGORIES) expect(normalizeCategory(c)).toBe(c)
  })

  it('大小写与空白容错（模型会吐 "Knowledge" / " knowledge "）', () => {
    expect(normalizeCategory('Knowledge')).toBe('knowledge')
    expect(normalizeCategory('  rule  ')).toBe('rule')
    expect(normalizeCategory('EXPERIENCE')).toBe('experience')
  })

  it('历史别名按 CATEGORY_ALIASES 折算', () => {
    expect(normalizeCategory('fact')).toBe('knowledge')      // 已废弃的第四类
    expect(normalizeCategory('经验')).toBe('experience')     // 实测库里真有的中文脏值
    expect(normalizeCategory('事实')).toBe('knowledge')
    expect(normalizeCategory('偏好')).toBe('preference')
    expect(normalizeCategory('约定')).toBe('rule')
    expect(normalizeCategory('关注')).toBe('topic')
  })

  it('无法识别一律落 general，绝不抛错', () => {
    for (const bad of ['cat', 'xxx', '123', '', '   ', 'null', 'undefined']) {
      expect(normalizeCategory(bad)).toBe('general')
    }
  })

  it('非字符串入参落 general（不抛错）', () => {
    for (const bad of [null, undefined, 42, {}, [], true, Symbol('s')]) {
      expect(normalizeCategory(bad as any)).toBe('general')
    }
  })

  it('别名表的值必须都是现行枚举项（防止别名指向一个已废弃的分类）', () => {
    for (const [from, to] of Object.entries(CATEGORY_ALIASES)) {
      expect(isMemoryCategory(to), `别名 ${from} → ${to} 非法`).toBe(true)
    }
  })

  it('别名表不得把合法分类映射去别处（fact 例外，它本身已不是合法分类）', () => {
    for (const [from, to] of Object.entries(CATEGORY_ALIASES)) {
      if (isMemoryCategory(from)) expect(to).toBe(from)
    }
  })
})

describe('categoryWeight 取权重', () => {
  it('合法分类取表内值', () => {
    expect(categoryWeight('preference')).toBe(1.6)
    expect(categoryWeight('general')).toBe(0.8)
  })

  it('未知分类退 1.0 而非 0（历史脏值不该直接沉底）', () => {
    expect(categoryWeight('经验')).toBe(1.0)
    expect(categoryWeight('')).toBe(1.0)
    expect(categoryWeight(undefined as any)).toBe(1.0)
  })
})

describe('normalizeImportance 收敛 1..10', () => {
  it('区间内原样返回（取整）', () => {
    expect(normalizeImportance(5)).toBe(5)
    expect(normalizeImportance(7.4)).toBe(7)
  })

  it('越界被夹到 [1,10]', () => {
    expect(normalizeImportance(0)).toBe(1)
    expect(normalizeImportance(-99)).toBe(1)
    expect(normalizeImportance(999)).toBe(10)
  })

  it('字符串数字可解析（小数按 parseInt 截断，与历史行为一致）', () => {
    expect(normalizeImportance('8')).toBe(8)
    expect(normalizeImportance('9.6')).toBe(9)
  })

  it('不可解析落默认 5', () => {
    for (const bad of [null, undefined, '', 'abc', {}, NaN, Infinity]) {
      expect(normalizeImportance(bad as any)).toBe(5)
    }
  })
})
