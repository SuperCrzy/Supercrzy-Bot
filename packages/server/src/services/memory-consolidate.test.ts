/**
 * memory-consolidate.ts 测试（#147，2026-09-18）
 *
 * 阈值不是拍脑袋定的：`keySimilarity` 的用例直接取自**真实库里的 key**，
 * 其中"该合"的（news 类扎堆）与"不该合"的（browser 操作 vs 写报告）都来自实测数据，
 * 保证阈值在真实分布上标定过，而不是在臆想的样本上调参。
 *
 * 最重要的一条不变量：**任何一行不得同时出现在两个合并组里**。
 * 若破坏，某一组的 winner 可能被另一组当成员删掉 → 该主题的内容彻底丢失，
 * 且是不可逆的。真实库试算时专门验过（214 条 → 193 条，零违规）。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  consolidateMemories,
  keySimilarity,
  keyTokens,
  CATEGORY_CAP,
  DEFAULT_MERGE_THRESHOLD,
} from './memory-consolidate'
import { ensureMemoryTable } from './memory-service'

let db: any

beforeEach(() => {
  db = new (Database as any)(':memory:')
  ensureMemoryTable(db)
})

interface Row {
  id: string
  key: string
  category?: string
  importance?: number
  confidence?: number
  usage?: number
  created?: string
}

function seed(rows: Row[]) {
  const stmt = db.prepare(
    `INSERT INTO agent_memory (id, key, content, category, importance, confidence, usage_count, last_used, role_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  )
  for (const r of rows) {
    const t = r.created ?? '2026-09-01 00:00:00'
    stmt.run(
      r.id, r.key, `content of ${r.id}`, r.category ?? 'experience',
      r.importance ?? 5, r.confidence ?? 0.5, r.usage ?? 0, t, t,
    )
  }
}

const allIds = () => (db.prepare('SELECT id FROM agent_memory ORDER BY id').all() as any[]).map((r) => r.id)
const count = () => (db.prepare('SELECT COUNT(*) n FROM agent_memory').get() as any).n
const row = (id: string) => db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(id) as any

// ── keyTokens / keySimilarity（阈值标定）────────────────────────────
describe('keyTokens 词元切分', () => {
  it('去停用词：分类名前缀不参与相似度（否则任意两条同分类记忆都"相似"）', () => {
    expect(keyTokens('经验:verified-news-search')).toEqual(['verified', 'news', 'search'])
  })

  it('英文按连字符/下划线/冒号切开', () => {
    expect(keyTokens('pref:short_answers-v2')).toEqual(['pref', 'short', 'answers', 'v2'])
  })

  it('中文长串补字符二元组（中文不分词，整串当词元会永不重合）', () => {
    const t = keyTokens('整理记忆系统')
    expect(t).toContain('记忆')
    expect(t).toContain('系统')
  })

  it('去单字符（噪声大、易误合）', () => {
    expect(keyTokens('a b cd')).toEqual(['cd'])
  })

  it('空 / 非法输入返回空数组（不抛错）', () => {
    expect(keyTokens('')).toEqual([])
    expect(keyTokens(null as any)).toEqual([])
    expect(keyTokens('!!!---:::')).toEqual([])
  })
})

describe('keySimilarity 阈值在真实数据上的标定', () => {
  it('完全相同 → 1.0', () => {
    expect(keySimilarity('经验:ai-news-digest', '经验:ai-news-digest')).toBe(1)
  })

  it('同主题换词序/加修饰词 → ≥ 阈值（该合）', () => {
    // 全部取自真实库中"明显是同一件事"的几组
    const shouldMerge: Array<[string, string]> = [
      ['经验:verified-news-search', '经验:cross-verified-news-search'],
      ['经验:cross-verified-news-digest', '经验:verified-news-digest'],
      ['经验:daily-news-digest', '经验:daily-ai-news-digest'],
      ['经验:Verify that shell_exec i', '经验:Verify that the shell to'],
    ]
    for (const [a, b] of shouldMerge) {
      expect(keySimilarity(a, b), `${a} ⟷ ${b}`).toBeGreaterThanOrEqual(DEFAULT_MERGE_THRESHOLD)
    }
  })

  /**
   * 阈值边界样本：3 词元 key 换掉 1 个词 → Jaccard = 0.5，**刚好落在阈值下方，刻意不合并**。
   *
   * 这是有意的保守取舍，不是标定失误：合并会 DELETE 行、不可逆，
   * 而漏合只是多留一条（还能靠后续整理收敛）。所以宁可把阈值放在
   * "3 词元里换 1 个词就不合"这一侧。
   * 真实库的实测支持这个选择：21/105 条 experience 被合并，且零误合。
   * 若哪天想更激进，改 DEFAULT_MERGE_THRESHOLD 即可 —— 这条用例会同时红掉，提醒那是一次行为变更。
   */
  it('边界：3 词元换 1 词（0.5）落阈值下方 → 不合并', () => {
    expect(keySimilarity('经验:ai-news-briefing', '经验:ai-news-digest')).toBeCloseTo(0.5, 5)
    expect(keySimilarity('经验:ai-news-briefing', '经验:ai-news-digest')).toBeLessThan(DEFAULT_MERGE_THRESHOLD)
  })

  it('不同技能 → 远低于阈值（不该合，误合会丢内容）', () => {
    const shouldNotMerge: Array<[string, string]> = [
      // 浏览器操作 vs 写报告：都是"上网干活"但是两种能力
      ['经验:browser-navigate-click-summarize', '经验:browse-web-and-report'],
      ['经验:browser-navigate-click-summarize', '经验:browser-visual-inspect-and-navigate'],
      // 危险命令的安全处理 vs 安全删除命令处理
      ['经验:dangerous-command-safety', '经验:safe-destructive-command-handling'],
      ['经验:code-invariant-extraction', '经验:codebase-purpose-discovery'],
      ['经验:write-project-introduction', '经验:product-introduction-writer'],
      ['经验:验证 shell 工具是否可由 AI 调用并正确', '经验:执行一个简单的 shell 命令以获取输出'],
    ]
    for (const [a, b] of shouldNotMerge) {
      expect(keySimilarity(a, b), `${a} ⟷ ${b}`).toBeLessThan(DEFAULT_MERGE_THRESHOLD)
    }
  })

  it('任一侧无有效词元 → 0（不可判就不合）', () => {
    expect(keySimilarity('经验:', '经验:')).toBe(0)
    expect(keySimilarity('', '经验:news')).toBe(0)
  })
})

// ── 合并 ──────────────────────────────────────────────────────
describe('consolidateMemories 合并近似重复', () => {
  it('同主题不同措辞 → 合成一条，保留价值最高的', () => {
    seed([
      { id: 'a', key: '经验:verified-news-search', importance: 9, usage: 3 },
      { id: 'b', key: '经验:cross-verified-news-search', importance: 4 },
    ])
    const rep = consolidateMemories(db, { noEvict: true })
    expect(count()).toBe(1)
    expect(allIds()).toEqual(['a'])
    expect(rep.mergedGroups).toHaveLength(1)
    expect(rep.mergedGroups[0].winnerId).toBe('a')
  })

  it('簇首按价值打分选（不是按插入顺序/importance 单指标）', () => {
    seed([
      { id: 'low', key: '经验:verified-news-search', importance: 4, confidence: 0.3, usage: 1 },
      { id: 'high', key: '经验:cross-verified-news-search', importance: 9, confidence: 0.9, usage: 5 },
    ])
    const rep = consolidateMemories(db, { noEvict: true })
    // 打分 = (0.3+imp/10)×confidence×decay×catWeight → high 明显更高，应当胜出
    expect(rep.mergedGroups[0].winnerId).toBe('high')
    expect(row('high')).toBeTruthy()
    expect(row('low')).toBeUndefined()
  })

  /**
   * 关键性质：**簇首可能不是 importance 最高的那条**，但合并不因此丢失价值标记。
   * 所以断言要盯"存活行的统计量"，而不是盯某个 id —— 盯 id 会把实现细节写进测试。
   */
  it('合并不丢价值标记：importance/confidence 取 MAX、usage_count 求和（与谁是簇首无关）', () => {
    seed([
      { id: 'low', key: '经验:verified-news-search', importance: 4, confidence: 0.3, usage: 1 },
      { id: 'high', key: '经验:cross-verified-news-search', importance: 9, confidence: 0.9, usage: 5 },
    ])
    consolidateMemories(db, { noEvict: true })
    expect(count()).toBe(1)
    const survivor = db.prepare('SELECT * FROM agent_memory LIMIT 1').get() as any
    expect(survivor.importance).toBe(9)     // 高重要度不因"不是簇首"而丢失
    expect(survivor.confidence).toBe(0.9)
    expect(survivor.usage_count).toBe(6)    // 热度累加，不丢
  })

  it('绝不跨分类合并（同 key 都不会合）', () => {
    seed([
      { id: 'e', key: '经验:news-verification', category: 'experience' },
      { id: 'k', key: '经验:news-verification', category: 'knowledge' },
    ])
    const rep = consolidateMemories(db, { noEvict: true })
    expect(count()).toBe(2)
    expect(rep.mergedGroups).toHaveLength(0)
  })

  it('词元太少（< minTokens）的 key 不参与合并（判不准就放过）', () => {
    seed([
      { id: 'a', key: '经验:x1', importance: 5 },
      { id: 'b', key: '经验:x2', importance: 5 },
    ])
    consolidateMemories(db, { noEvict: true })
    expect(count()).toBe(2)
  })

  it('星型聚类：不链式传递（A~B、B~C 但 A!~C 时不合，避免整类串成一簇）', () => {
    // 构造三个 key：中项与两侧都相似，但两侧之间不相似
    seed([
      { id: 'a', key: '经验:alpha-bravo', importance: 9 },
      { id: 'b', key: '经验:alpha-bravo-charlie', importance: 8 },
      { id: 'c', key: '经验:charlie-delta', importance: 7 },
    ])
    const rep = consolidateMemories(db, { noEvict: true })
    // 无论合出什么，都不能三条全并成一条（链式传递就会）
    expect(count()).toBeGreaterThan(1)
    expect(rep.mergedGroups.every((g) => g.merged.length < 2)).toBe(true)
  })

  it('单簇成员数受 maxCluster 限制', () => {
    // 8 个都跟簇首高度相似的 key（同一前缀 + 各自独特的第 3 词）
    seed(Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, key: `经验:shared-term-word${i}`, importance: 9 - i })))
    const rep = consolidateMemories(db, { noEvict: true, maxCluster: 3 })
    const maxMerged = Math.max(0, ...rep.mergedGroups.map((g) => g.merged.length))
    expect(maxMerged).toBeLessThanOrEqual(3)
  })

  it('★不变量：任何一行不得同时出现在两个合并组里', () => {
    // 复现真实库的"同 key 多行 + 近似 key"混合场景
    seed([
      { id: 'v1', key: '经验:verified-news-search', importance: 9 },
      { id: 'v2', key: '经验:verified-news-search', importance: 8 },
      { id: 'v3', key: '经验:verified-news-search', importance: 7 },
      { id: 'c1', key: '经验:cross-verified-news-search', importance: 6 },
      { id: 'c2', key: '经验:cross-verified-news-search', importance: 5 },
      { id: 'a1', key: '经验:verified-ai-news-search', importance: 4 },
    ])
    const rep = consolidateMemories(db, { noEvict: true })

    const seen = new Map<string, number>()
    for (const g of rep.mergedGroups) {
      for (const id of [g.winnerId, ...g.merged.map((m) => m.id)]) seen.set(id, (seen.get(id) ?? 0) + 1)
    }
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1)
    expect(duplicated).toEqual([])

    // 结果自洽：每条存活的行都没有被视为"已被合并掉"
    const removed = new Set(rep.mergedGroups.flatMap((g) => g.merged.map((m) => m.id)))
    for (const id of allIds()) expect(removed.has(id), `${id} 被删却仍存活`).toBe(false)
    expect(count()).toBe(6 - removed.size)
  })

  it('dryRun 试算：报表如实统计，但零写入', () => {
    seed([
      { id: 'a', key: '经验:ai-news-digest', importance: 5 },
      { id: 'b', key: '经验:ai-news-digest', importance: 5 },
    ])
    const before = count()
    const rep = consolidateMemories(db, { dryRun: true, noEvict: true })
    expect(rep.dryRun).toBe(true)
    expect(rep.removed).toBe(1)          // 报表要如实（曾是 bug：dryRun 下恒为 0）
    expect(rep.after).toBe(before - 1)
    expect(rep.mergedGroups).toHaveLength(1)
    expect(count()).toBe(before)          // 但一行不动
  })

  /**
   * 跨轮"接力"合并（★真实 bug 的回归用例）
   *
   * 触发条件：同一主题的近似重复**超过单簇上限 maxCluster(6)**。
   * 第一轮：价值最高的那行当簇首吸收 6 条，剩下的没被吸收；
   * 第二轮：剩下的那条当簇首，把第一轮的簇首**吸收进来删掉** —— 于是出现"幸存者被当成员删"。
   *
   * 首版实现踩了两个坑，都是靠真实库端到端验证才发现的（单测当时是全绿的）：
   *   ① 统计量陈旧：第二轮从最初的快照读上一轮幸存者的 importance/usage，
   *      把已归并进来的价值标记与使用热度**丢掉**（实测 importance 7 < 8、usage 11 ≠ 32）
   *   ② 报表自相矛盾：同一行既当 winner 又当 member，还留下一条指向已删行的记录
   * 现在两个坑都有断言看守。
   */
  it('★跨轮接力：重复行超过单簇上限时，最终幸存者必须吸收全部贡献', () => {
    seed([
      { id: 'v1', key: '经验:verified-news-search', importance: 9, usage: 1 },
      { id: 'v2', key: '经验:verified-news-search', importance: 8, usage: 2 },
      { id: 'v3', key: '经验:verified-news-search', importance: 7, usage: 3 },
      { id: 'v4', key: '经验:verified-news-search', importance: 6, usage: 4 },
      { id: 'c1', key: '经验:cross-verified-news-search', importance: 5, usage: 5 },
      { id: 'c2', key: '经验:cross-verified-news-search', importance: 4, usage: 6 },
      { id: 'c3', key: '经验:cross-verified-news-search', importance: 3, usage: 7 },
      { id: 'c4', key: '经验:cross-verified-news-search', importance: 2, usage: 8 },
    ])
    const rep = consolidateMemories(db, { noEvict: true })

    // 8 条同主题 → 收敛成 1 条
    expect(count()).toBe(1)
    expect(rep.removed).toBe(7)
    expect(rep.mergePasses).toBeGreaterThan(1)   // 确实发生了跨轮接力

    const survivor = db.prepare('SELECT * FROM agent_memory LIMIT 1').get() as any
    // ★坑①：价值标记取全局 MAX、使用热度取全局 SUM（不能因跨轮而丢）
    expect(survivor.importance).toBe(9)
    expect(survivor.usage_count).toBe(1 + 2 + 3 + 4 + 5 + 6 + 7 + 8)

    // ★坑②：报告必须只指向活着的行，且任一行不跨组
    const alive = new Set(allIds())
    expect(alive.has(survivor.id)).toBe(true)
    expect(rep.mergedGroups).toHaveLength(1)
    expect(rep.mergedGroups[0].winnerId).toBe(survivor.id)
    expect(rep.mergedGroups[0].winnerKey).toBe(survivor.key)

    const seen = new Map<string, number>()
    for (const g of rep.mergedGroups) {
      for (const id of [g.winnerId, ...g.merged.map((m) => m.id)]) seen.set(id, (seen.get(id) ?? 0) + 1)
    }
    expect([...seen.entries()].filter(([, n]) => n > 1)).toEqual([])
    // 被并入的 7 条应全部出现在报告里，且都已不在库中
    expect(rep.mergedGroups[0].merged.map((m) => m.id).sort()).toEqual(
      ['c1', 'c2', 'c3', 'c4', 'v2', 'v3', 'v4'],
    )
    for (const m of rep.mergedGroups[0].merged) expect(alive.has(m.id)).toBe(false)
  })

  it('★跨轮接力的 dryRun 与真实执行结果一致（试算才有参考价值）', () => {
    const rows = [
      { id: 'v1', key: '经验:verified-news-search', importance: 9, usage: 1 },
      { id: 'v2', key: '经验:verified-news-search', importance: 8, usage: 2 },
      { id: 'v3', key: '经验:verified-news-search', importance: 7, usage: 3 },
      { id: 'v4', key: '经验:verified-news-search', importance: 6, usage: 4 },
      { id: 'c1', key: '经验:cross-verified-news-search', importance: 5, usage: 5 },
      { id: 'c2', key: '经验:cross-verified-news-search', importance: 4, usage: 6 },
      { id: 'c3', key: '经验:cross-verified-news-search', importance: 3, usage: 7 },
      { id: 'c4', key: '经验:cross-verified-news-search', importance: 2, usage: 8 },
    ]
    seed(rows)
    const dry = consolidateMemories(db, { dryRun: true, noEvict: true })
    expect(count()).toBe(8)                      // 试算零写入
    const real = consolidateMemories(db, { noEvict: true })

    expect(dry.removed).toBe(real.removed)
    expect(dry.after).toBe(real.after)
    expect(dry.mergePasses).toBe(real.mergePasses)
    expect(dry.mergedGroups.length).toBe(real.mergedGroups.length)
    expect(dry.mergedGroups[0].winnerId).toBe(real.mergedGroups[0].winnerId)
    expect(dry.mergedGroups[0].merged.map((m) => m.id).sort())
      .toEqual(real.mergedGroups[0].merged.map((m) => m.id).sort())
  })

  it('整理一次即收敛到不动点（复跑零变化）', () => {
    seed([
      ...Array.from({ length: 4 }, (_, i) => ({ id: `v${i}`, key: '经验:verified-news-search', importance: 9 - i })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, key: '经验:cross-verified-news-search', importance: 5 - i })),
    ])
    consolidateMemories(db, { noEvict: true })
    const after1 = count()
    const rep2 = consolidateMemories(db, { noEvict: true })
    expect(rep2.removed).toBe(0)
    expect(count()).toBe(after1)
  })
})

// ── 淘汰 ──────────────────────────────────────────────────────
describe('consolidateMemories 按分类上限淘汰', () => {
  it('未超上限 → 一条不淘汰', () => {
    seed(Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, key: `经验:topic-${i}`, importance: 2 })))
    const rep = consolidateMemories(db)
    expect(rep.evicted).toHaveLength(0)
    expect(count()).toBe(10)
  })

  it('超上限 → 只淘汰 importance ≤ 4 的低价值行', () => {
    const cap = CATEGORY_CAP.experience
    // cap 条高价值 + 5 条高价值 + 5 条低价值
    seed([
      ...Array.from({ length: cap }, (_, i) => ({ id: `hi${i}`, key: `经验:hi-${i}`, importance: 8 })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `mid${i}`, key: `经验:mid-${i}`, importance: 6 })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `lo${i}`, key: `经验:lo-${i}`, importance: 2 })),
    ])
    const rep = consolidateMemories(db)
    // 高价值行（含 importance 6 的 mid）绝不淘汰 → 只淘汰得掉 importance ≤ 4 的行
    expect(rep.evicted.every((e) => e.importance <= 4)).toBe(true)
    expect(rep.evicted.map((e) => e.id).sort()).toEqual(['lo0', 'lo1', 'lo2', 'lo3', 'lo4'])
    expect(row('mid0')).toBeTruthy()
    expect(row('hi0')).toBeTruthy()
  })

  it('evict=false / noEvict 时只合并不淘汰', () => {
    const cap = CATEGORY_CAP.experience
    seed(Array.from({ length: cap + 3 }, (_, i) => ({ id: `e${i}`, key: `经验:topic-${i}`, importance: 2 })))
    const rep = consolidateMemories(db, { noEvict: true })
    expect(rep.evicted).toHaveLength(0)
    expect(count()).toBe(cap + 3)
  })

  it('各分类上限按 CATEGORY_CAP 生效（未列入的分类退 general 上限）', () => {
    expect(CATEGORY_CAP.experience).toBe(100)
    expect(CATEGORY_CAP.knowledge).toBeGreaterThan(CATEGORY_CAP.general)
  })
})

// ── 健壮性 ────────────────────────────────────────────────────
describe('consolidateMemories 健壮性', () => {
  it('空表 → 空报表且不抛错', () => {
    const rep = consolidateMemories(db)
    expect(rep.before).toBe(0)
    expect(rep.summary).toContain('为空')
  })

  it('db 抛错 → 返回报表含错误摘要，不向外抛', () => {
    const broken = { prepare() { throw new Error('database is locked') } }
    const rep = consolidateMemories(broken as any)
    expect(rep.summary).toContain('database is locked')
  })

  it('summary 是人话且含关键数字', () => {
    seed([
      { id: 'a', key: '经验:ai-news-digest', importance: 5 },
      { id: 'b', key: '经验:ai-news-digest', importance: 5 },
    ])
    const rep = consolidateMemories(db, { noEvict: true })
    expect(rep.summary).toMatch(/合并 1 组/)
    expect(rep.summary).toMatch(/总量 2 → 1/)
  })

  it('幂等：连续整理两次，第二次不再变化', () => {
    seed([
      { id: 'a', key: '经验:ai-news-digest', importance: 5 },
      { id: 'b', key: '经验:ai-news-digest', importance: 5 },
      { id: 'c', key: '经验:verified-news-search', importance: 5 },
      { id: 'd', key: '经验:cross-verified-news-search', importance: 5 },
    ])
    consolidateMemories(db, { noEvict: true })
    const midCount = count()
    const rep2 = consolidateMemories(db, { noEvict: true })
    expect(count()).toBe(midCount)
    expect(rep2.removed).toBe(0)
  })
})
