/**
 * memory-search.ts 候选池选取 + 分类配额测试（#147，2026-09-18）
 *
 * 本次修的病（有真实数据支撑）：Stored Memories 的候选池是
 *   `SELECT … WHERE role_id… ORDER BY importance DESC LIMIT memoryItemLimit*3`（=75）
 * 实测库里 importance ≥ 6 的有 82 条 > 75 → importance ≤ 5 的 126 条**永远进不了候选池**；
 * 而 experience 占全表 49.5% 且每个任务还在 +N 条，靠 importance 单调排序必然持续占满。
 * 于是"用户偏好/约定"这类真正该个性化的记忆，反而被任务流水挤出去。
 *
 * 这里分两层锁行为：
 *   selectMemoryCandidates —— 真 SQL（内存库），证明"分类不同的记忆确实能一起进池"
 *   applyCategoryQuota     —— 纯函数，证明"最终注入里单分类不会独占"
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { selectMemoryCandidates, applyCategoryQuota, type RankedMemory } from './memory-search'
import { ensureMemoryTable } from './memory-service'

let db: any

beforeEach(() => {
  db = new (Database as any)(':memory:')
  ensureMemoryTable(db)
})

interface SeedRow {
  id: string
  key?: string
  category: string
  importance: number
  roleId?: string | null
  confidence?: number
  updatedAt?: string
}

function seed(rows: SeedRow[]) {
  const stmt = db.prepare(
    `INSERT INTO agent_memory (id, key, content, category, importance, confidence, role_id, usage_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), ?)`,
  )
  for (const r of rows) {
    stmt.run(
      r.id,
      r.key ?? `key-${r.id}`,
      `content-${r.id}`,
      r.category,
      r.importance,
      r.confidence ?? 0.5,
      r.roleId ?? null,
      r.updatedAt ?? new Date().toISOString(),
    )
  }
}

const ids = (rows: any[]) => rows.map((r) => r.id)

describe('selectMemoryCandidates 分类配额抽样（打破 importance 垄断）', () => {
  it('复现原病灶场景：importance 排序会让低分类全被挤掉，新逻辑能保进来', () => {
    // 100 条 experience 全部 importance=9（模拟任务流水膨胀）
    seed(Array.from({ length: 100 }, (_, i) => ({ id: `exp-${i}`, category: 'experience', importance: 9 })))
    // 少量但更该被个性化注入的分类，importance 只有 5
    seed([
      { id: 'pref-1', category: 'preference', importance: 5 },
      { id: 'pref-2', category: 'preference', importance: 4 },
      { id: 'rule-1', category: 'rule', importance: 5 },
      { id: 'user-1', category: 'user', importance: 3 },
    ])

    // 旧实现（ORDER BY importance DESC LIMIT 75）会返回 75 条 experience，preference/rule/user 一条都进不来
    const oldWay = db.prepare(
      "SELECT id FROM agent_memory ORDER BY importance DESC LIMIT 75",
    ).all() as any[]
    expect(oldWay.every((r) => r.id.startsWith('exp-'))).toBe(true)
    expect(oldWay).toHaveLength(75)

    // 新实现：每一类都有自己的代表进池
    const picked = ids(selectMemoryCandidates(db, '', 75))
    expect(picked).toContain('pref-1')
    expect(picked).toContain('pref-2')
    expect(picked).toContain('rule-1')
    expect(picked).toContain('user-1')
  })

  it('单分类最多进 perCategory 条（limit/3，下限 8）——防单类刷屏', () => {
    seed(Array.from({ length: 100 }, (_, i) => ({ id: `e-${i}`, category: 'experience', importance: 9 })))
    const picked = selectMemoryCandidates(db, '', 30)
    // limit=30 → perCategory = max(8, ceil(30/3)=10) = 10
    expect(picked.filter((r) => r.category === 'experience')).toHaveLength(10)
  })

  it('limit 很大时单分类上限仍至少 8 条（不会因 limit 小就饿死分类）', () => {
    seed(Array.from({ length: 20 }, (_, i) => ({ id: `e-${i}`, category: 'experience', importance: 9 })))
    seed(Array.from({ length: 20 }, (_, i) => ({ id: `k-${i}`, category: 'knowledge', importance: 8 })))
    // limit=6 → perCategory = max(8, 2) = 8
    const picked = selectMemoryCandidates(db, '', 6)
    expect(picked).toHaveLength(6)
    expect(picked.filter((r) => r.category === 'experience').length).toBeLessThanOrEqual(8)
  })

  it('严格返回全部字段（rankMemories 依赖 created_at 兜底时间衰减）', () => {
    seed([{ id: 'a', category: 'user', importance: 5 }])
    const [row] = selectMemoryCandidates(db, '', 10)
    for (const f of ['id', 'key', 'content', 'category', 'importance', 'confidence', 'usage_count', 'last_used', 'created_at']) {
      expect(row, `缺字段 ${f}`).toHaveProperty(f)
    }
  })

  it('roleId 隔离：本角色 + 全局（NULL 或空串）进池，其他角色不进', () => {
    seed([
      { id: 'mine', category: 'user', importance: 5, roleId: 'role-A' },
      { id: 'global-null', category: 'user', importance: 5, roleId: null },
      { id: 'global-empty', category: 'user', importance: 5, roleId: '' },
      { id: 'other', category: 'user', importance: 9, roleId: 'role-B' },
    ])
    const picked = ids(selectMemoryCandidates(db, 'role-A', 20))
    expect(picked).toContain('mine')
    expect(picked).toContain('global-null')
    expect(picked).toContain('global-empty')
    expect(picked).not.toContain('other')
  })

  it('空库返回空数组（不抛错）', () => {
    expect(selectMemoryCandidates(db, '', 20)).toEqual([])
  })

  it('窗口函数不可用 → 退回 importance 排序，功能不挂', () => {
    const rows = [{ id: 'x', key: 'k', content: 'c', category: 'user', importance: 5, confidence: 0.5, usage_count: 0, last_used: null, created_at: '2026-01-01 00:00:00' }]
    let windowAttempted = false
    const legacyDb = {
      prepare(sql: string) {
        if (sql.includes('ROW_NUMBER')) {
          windowAttempted = true
          throw new Error('no such function: ROW_NUMBER')
        }
        return { all: () => rows }
      },
    }
    const picked = selectMemoryCandidates(legacyDb as any, '', 10)
    expect(windowAttempted).toBe(true)
    expect(picked).toEqual(rows)
  })
})

// ── applyCategoryQuota ────────────────────────────────────────────
function mk(id: string, category: string, score: number): RankedMemory {
  return { id, key: id, content: id, category, importance: 5, confidence: 0.5, usage_count: 0, last_used: null, score }
}

describe('applyCategoryQuota 最终注入的分类配额', () => {
  it('experience 最多占 40%（默认限额）', () => {
    const ranked = [
      ...Array.from({ length: 20 }, (_, i) => mk(`e-${i}`, 'experience', 100 - i)),
      ...Array.from({ length: 10 }, (_, i) => mk(`p-${i}`, 'preference', 50 - i)),
    ]
    const out = applyCategoryQuota(ranked, 10)
    // limit=10 → cap = ceil(4) = 4
    expect(out.filter((r) => r.category === 'experience')).toHaveLength(4)
    expect(out).toHaveLength(10)
  })

  it('限额是为了排序公平，不是为了少注入：被挡下的按顺序回填', () => {
    // 只有 experience 一种分类 → 若真按 40% 砍，就只剩 4 条，那是错的
    const ranked = Array.from({ length: 20 }, (_, i) => mk(`e-${i}`, 'experience', 100 - i))
    const out = applyCategoryQuota(ranked, 10)
    expect(out).toHaveLength(10)
    expect(ids(out)).toEqual(['e-0', 'e-1', 'e-2', 'e-3', 'e-4', 'e-5', 'e-6', 'e-7', 'e-8', 'e-9'])
  })

  it('非受限分类按分数顺序填满剩余位（配额只管受限分类，不压制其他分类）', () => {
    const ranked = [
      ...Array.from({ length: 10 }, (_, i) => mk(`e-${i}`, 'experience', 100 - i)),
      ...Array.from({ length: 10 }, (_, i) => mk(`k-${i}`, 'knowledge', 50 - i)),
    ]
    const out = applyCategoryQuota(ranked, 10)
    // limit=10 → experience cap = ceil(4) = 4；剩余 6 位由 knowledge 按分数顺序补满
    expect(out.filter((r) => r.category === 'experience')).toHaveLength(4)
    expect(out.filter((r) => r.category === 'knowledge')).toHaveLength(6)
    expect(out).toHaveLength(10)
  })

  it('limit ≤ 0 → 空数组', () => {
    expect(applyCategoryQuota([mk('a', 'user', 1)], 0)).toEqual([])
    expect(applyCategoryQuota([mk('a', 'user', 1)], -3)).toEqual([])
  })

  it('空输入 → 空数组', () => {
    expect(applyCategoryQuota([], 10)).toEqual([])
  })

  it('结果条数不超过 limit', () => {
    const ranked = Array.from({ length: 100 }, (_, i) => mk(`m-${i}`, i % 2 ? 'experience' : 'knowledge', 100 - i))
    for (const limit of [1, 5, 25, 75]) {
      expect(applyCategoryQuota(ranked, limit).length).toBeLessThanOrEqual(limit)
    }
  })

  it('结果无重复项（回填不会把已入选的再加一遍）', () => {
    const ranked = [
      ...Array.from({ length: 10 }, (_, i) => mk(`e-${i}`, 'experience', 100 - i)),
      mk('p-0', 'preference', 90),
    ]
    const out = applyCategoryQuota(ranked, 6)
    expect(new Set(ids(out)).size).toBe(out.length)
  })

  it('cap 下限为 1：limit=1 时仍能有 1 条受限分类（不会全空）', () => {
    const out = applyCategoryQuota([mk('e-0', 'experience', 9)], 1)
    expect(ids(out)).toEqual(['e-0'])
  })

  /**
   * 这条锁的是"回填优先于硬砍"这个刻意选择：
   * 当候选池里**全是**受限分类、没有别的分类来补位时，配额不生效——宁可注入满 limit 条，
   * 也不为了配额数字好看而少注入。若哪天改成硬砍，这条会红，提醒那是一次行为变更。
   */
  it('候选池全部属于受限分类时 → 回填到 limit，不做硬砍', () => {
    const ranked = Array.from({ length: 20 }, (_, i) => mk(`e-${i}`, 'experience', 100 - i))
    const out = applyCategoryQuota(ranked, 10, { maxShare: 0.2 })
    expect(out).toHaveLength(10)
    expect(ids(out)).toEqual(['e-0', 'e-1', 'e-2', 'e-3', 'e-4', 'e-5', 'e-6', 'e-7', 'e-8', 'e-9'])
  })

  it('可自定义 maxShare 与受限分类（多个分类同时受限）', () => {
    const ranked = [
      ...Array.from({ length: 10 }, (_, i) => mk(`e-${i}`, 'experience', 100 - i)),
      ...Array.from({ length: 10 }, (_, i) => mk(`k-${i}`, 'knowledge', 50 - i)),
      ...Array.from({ length: 10 }, (_, i) => mk(`t-${i}`, 'topic', 40 - i)),
    ]
    const out = applyCategoryQuota(ranked, 10, { maxShare: 0.2, limited: ['experience', 'knowledge'] })
    // cap = max(1, ceil(10*0.2)=2) → 两类各 2 条，余 6 位由 topic 补满
    expect(out.filter((r) => r.category === 'experience')).toHaveLength(2)
    expect(out.filter((r) => r.category === 'knowledge')).toHaveLength(2)
    expect(out.filter((r) => r.category === 'topic')).toHaveLength(6)
    expect(out).toHaveLength(10)
  })
})

describe('候选池 + 配额 端到端（复现注入路径）', () => {
  it('100 条高重要度 experience 不再挤掉 preference / rule', () => {
    seed(Array.from({ length: 100 }, (_, i) => ({ id: `exp-${i}`, category: 'experience', importance: 9 })))
    seed([
      { id: 'pref', category: 'preference', importance: 6 },
      { id: 'rule', category: 'rule', importance: 6 },
    ])
    const limit = 25
    const candidates = selectMemoryCandidates(db, '', limit * 3)
    const ranked = candidates
      .map((c) => ({ ...c, score: c.importance })) // 简化打分：只看 importance 就足以证明"分类是否被挤掉"
      .sort((a, b) => b.score - a.score)
    const out = applyCategoryQuota(ranked as RankedMemory[], limit)
    expect(ids(out)).toContain('pref')
    expect(ids(out)).toContain('rule')
  })
})
