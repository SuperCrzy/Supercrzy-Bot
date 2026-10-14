import { getDB } from './database'
import { getEmbeddings, embeddingEnabled, normCosine } from './embedding'
import { MEMORY_CATEGORIES, categoryWeight } from './memory-category'

/**
 * Memory Retrieval Ranking（P0.1 定稿规格，2026-08-23）
 *
 * 核心思想：FTS5 是检索引擎，排序才是记忆系统。
 * score = (0.3 + importance/10) × confidence × timeDecay × categoryWeight
 * timeDecay = 0.95 ^ daysSinceLastUsed（封顶 365 天）
 *
 * 2026-09-18：`categoryWeight` 从本文件私有的 4 项表（experience/user/knowledge/general）
 * 迁到 `memory-category.ts` 的权威表（覆盖全部 7 个实际分类）。
 * 原先 `preference`（用户偏好）与 `rule`（约定/教训）不在表里 → 落 `?? 1.0` 默认值，
 * 结果"越有用的越排不过任务流水"。
 */

export interface RankedMemory {
  id: string
  key: string
  content: string
  category: string
  importance: number
  confidence: number
  usage_count: number
  last_used: string | null
  score: number
}

/** 对已取出的记忆列表做 ranking 排序（Stored Memories 用，无需 FTS5） */
export function rankMemories(memories: any[]): RankedMemory[] {
  const now = Date.now()
  return memories
    .map((m) => {
      const importance = m.importance ?? 1
      const confidence = typeof m.confidence === 'number' ? m.confidence : 0.5
      // 时间衰减：last_used 缺失时退化为按创建时间衰减（避免 score≈0），都没有则用 30 天中性值
      const t = m.last_used || m.created_at
      const days = t ? (now - new Date(t).getTime()) / 86400000 : 30
      const decay = Math.pow(0.95, Math.min(Math.max(days, 0), 365))
      const catW = categoryWeight(m.category)
      return {
        id: m.id, key: m.key, content: m.content, category: m.category,
        importance, confidence, usage_count: m.usage_count ?? 0, last_used: m.last_used ?? null,
        score: (0.3 + importance / 10) * confidence * decay * catW,
      }
    })
    .sort((a, b) => b.score - a.score)
}

/**
 * 候选池选取（2026-09-18 新增，修"低分记忆被重要性垄断挤死"）
 *
 * 原实现是 `SELECT … ORDER BY importance DESC LIMIT memoryItemLimit*3`（= 75）。
 * 实测：库里 `importance ≥ 6` 的已有 82 条 > 75 → **`importance ≤ 5` 的 126 条永远进不了候选池**；
 * 且 experience 单品类占 49.5% 还在每日膨胀，会把池子持续占满。
 *
 * 新实现：先用窗口函数按分类各取前 perCategory 条（保证每个分类都有代表进池），
 * 再按 importance 截到 limit。这样"一个分类数量暴涨"不再能挤掉其它分类。
 */
export function selectMemoryCandidates(db: any, roleId: string, limit: number): any[] {
  const perCategory = Math.max(8, Math.ceil(limit / 3))
  try {
    return db.prepare(
      `SELECT id, key, content, category, importance, confidence, usage_count, last_used, created_at
         FROM (
           SELECT id, key, content, category, importance, confidence, usage_count, last_used, created_at,
                  ROW_NUMBER() OVER (PARTITION BY category ORDER BY importance DESC, updated_at DESC) AS rn
             FROM agent_memory
            WHERE (role_id IS NULL OR role_id = ? OR role_id = '')
         )
        WHERE rn <= ?
        ORDER BY importance DESC
        LIMIT ?`
    ).all(roleId || '', perCategory, limit) as any[]
  } catch (e: any) {
    // 窗口函数不可用（极老 SQLite）→ 退回原逻辑，保证功能不因排序优化而挂掉
    console.warn('[MemorySearch] 候选池窗口查询失败，退回 importance 排序:', e?.message || e)
    return db.prepare(
      `SELECT id, key, content, category, importance, confidence, usage_count, last_used, created_at
         FROM agent_memory
        WHERE (role_id IS NULL OR role_id = ? OR role_id = '')
        ORDER BY importance DESC LIMIT ?`
    ).all(roleId || '', limit) as any[]
  }
}

/**
 * 分类配额（2026-09-18 新增）
 *
 * 目的：防止单一分类独占 prompt 位。实测 experience 占全表 49.5% 且每个任务还在 +N 条，
 * 而它权重 1.5 又偏高——不设限的话它会持续把候选位吃光。
 *
 * 规则：按排名顺序入选；受限分类最多占 `ceil(limit × maxShare)` 个位；
 * 若因此没填满 limit，则回填被限额挡下的（**限额是为了排序公平，不是为了让注入变少**）。
 *
 * 纯函数，便于单测锁行为。
 */
export function applyCategoryQuota(
  ranked: RankedMemory[],
  limit: number,
  opts: { maxShare?: number; limited?: string[] } = {},
): RankedMemory[] {
  if (limit <= 0) return []
  const maxShare = opts.maxShare ?? 0.4
  const limited = new Set(opts.limited ?? ['experience'])
  const cap = Math.max(1, Math.ceil(limit * maxShare))

  const picked: RankedMemory[] = []
  const overflow: RankedMemory[] = []
  const used = new Map<string, number>()

  for (const r of ranked) {
    if (picked.length >= limit) break
    if (!limited.has(r.category)) { picked.push(r); continue }
    const n = used.get(r.category) ?? 0
    if (n < cap) { used.set(r.category, n + 1); picked.push(r) }
    else overflow.push(r)
  }
  for (const r of overflow) {
    if (picked.length >= limit) break
    picked.push(r)
  }
  return picked
}

/** FTS5 语义检索 + ranking：召回匹配记忆并按综合分数排序；命中即更新 usage_count/last_used */
export function memoryRankedSearch(query: string, limit = 5, roleId?: string): RankedMemory[] {
  const db = getDB()
  const q = String(query || '').trim()
  if (!q) return []

  // 拆词（中文按标点/空白切，英文按词）
  const tokens = q
    .split(/[\s,，。！？!?、;；:："'“”‘’（）()\[\]{}]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 6)

  // trigram 要求查询词 ≥3 字符：2 字中文词（分析/公司/搜索）通过 LIKE 补充召回（FTS 邻接拼接解决不了跨记忆匹配）
  const ftsTerms: string[] = []
  const shortTokens: string[] = []
  for (const t of tokens) {
    if (t.length >= 3) ftsTerms.push(t)
    else shortTokens.push(t)
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    const pair = tokens[i] + tokens[i + 1]
    if (pair.length >= 3) ftsTerms.push(pair)
  }
  const match = [...new Set(ftsTerms)].map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ')

  let rows: any[] = []
  if (match) {
    try {
      rows = db.prepare(
        `SELECT m.id, m.key, m.content, m.category, m.importance, m.confidence, m.usage_count, m.last_used, m.created_at,
                bm25(agent_memory_fts, 0.5, 1.0) AS fts_score
         FROM agent_memory_fts f
         JOIN agent_memory m ON m.rowid = f.rowid
         WHERE agent_memory_fts MATCH ?
           AND (m.role_id IS NULL OR m.role_id = ? OR m.role_id = '')
         ORDER BY fts_score
         LIMIT ?`
      ).all(match, roleId || '', limit * 6) as any[]
    } catch {
      rows = []
    }
  }

  // 2 字词 LIKE 补充召回（合并去重：FTS 召回了 experience 场景下 2 字词也参与排序）
  if (shortTokens.length > 0) {
    try {
      const likeSql = shortTokens.map(() => '(key LIKE ? OR content LIKE ?)').join(' OR ')
      const likeArgs = shortTokens.flatMap((t) => [`%${t}%`, `%${t}%`])
      const extra = db.prepare(
        `SELECT id, key, content, category, importance, confidence, usage_count, last_used, created_at
         FROM agent_memory
         WHERE (${likeSql})
           AND (role_id IS NULL OR role_id = ? OR role_id = '')
         LIMIT ?`
      ).all(...likeArgs, roleId || '', limit * 3) as any[]
      const seen = new Set(rows.map((r: any) => r.id))
      for (const e of extra) { if (!seen.has(e.id)) { rows.push(e); seen.add(e.id) } }
    } catch { /* ignore */ }
  }

  // 全部为空 → LIKE 按词 OR 兜底
  if (rows.length === 0 && tokens.length > 0) {
    try {
      const likeSql = tokens.map(() => '(key LIKE ? OR content LIKE ?)').join(' OR ')
      const likeArgs = tokens.flatMap((t) => [`%${t}%`, `%${t}%`])
      rows = db.prepare(
        `SELECT id, key, content, category, importance, confidence, usage_count, last_used, created_at
         FROM agent_memory
         WHERE (${likeSql})
           AND (role_id IS NULL OR role_id = ? OR role_id = '')
         LIMIT ?`
      ).all(...likeArgs, roleId || '', limit) as any[]
    } catch { /* ignore */ }
  }

  const ranked = rankMemories(rows).slice(0, limit)

  // 命中即更新使用统计（只在 FTS 或补充召回命中时，LIKE 全兜底不刷统计）
  if ((match || shortTokens.length > 0) && ranked.length > 0) {
    const stmt = db.prepare("UPDATE agent_memory SET usage_count = usage_count + 1, last_used = datetime('now') WHERE id = ?")
    for (const m of ranked) {
      try { stmt.run(m.id) } catch { /* ignore */ }
    }
  }

  return ranked
}

/**
 * embedding 混合检索（2026-08-23，对齐主流实现 `score = α·cosine + (1-α)·bm25Normalized`，α=0.8）
 * - 未配置 embedding key → 完全退化回纯 FTS5 ranking（与 memoryRankedSearch 同结果）
 * - 配置了 → 召回候选上融合：final = 0.8·normCosine(query, content) + 0.2·normRankScore
 * - 异步（embedding 需网络调用）；供 memory_recall 等 async 工具使用；系统提示注入保持同步 FTS5
 */
export async function memoryRankedSearchHybrid(query: string, limit = 5, roleId?: string): Promise<RankedMemory[]> {
  const base = memoryRankedSearch(query, limit * 3, roleId)
  if (base.length === 0 || !embeddingEnabled()) return base.slice(0, limit)

  const qEmbList = await getEmbeddings([query])
  const qEmb = qEmbList[0]
  if (!qEmb) return base.slice(0, limit)

  const embs = await getEmbeddings(base.map((m) => m.content))
  // rankScore 归一化（当前候选内 min-max → 0-1）
  const scores = base.map((m) => m.score)
  const min = Math.min(...scores), max = Math.max(...scores)
  const normRank = (s: number) => (max > min ? (s - min) / (max - min) : 1)

  const fused = base
    .map((m, i) => {
      const cos = embs[i] ? normCosine(qEmb, embs[i]!) : 0
      return { ...m, score: 0.8 * cos + 0.2 * normRank(m.score), _cos: cos }
    })
    .sort((a, b) => b.score - a.score)
  return fused.slice(0, limit)
}
