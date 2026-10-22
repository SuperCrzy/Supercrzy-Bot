/**
 * 记忆整理（#147，2026-09-18）
 *
 * 背景：`memory-store.ts` 侧只做"同 key 覆盖"的**精确**去重，它有一个硬上限——
 * key 不同就拦不住。实测真实库 103 条 experience 里有 88 个不同 key，
 * 因为 reflection 的 key 曾经取自 LLM 每次自由生成的 `problem` 句子
 * （"User wanted to know wher…" / "Verify that shell_exec i…"），永远不会撞车。
 * 所以"精确去重"只是地板，必须再有一层**定期整理**才能让表真正有界。
 *
 * 本模块做两件事，顺序执行：
 *
 * ┌─ ① 合并近似重复（merge）─────────────────────────────────────
 * │ 同一分类内，key 词元 Jaccard 相似度 ≥ 阈值的行归为一簇，
 * │ 保留「价值最高」的那条（用 rankMemories 同一套打分），其余并入后删除。
 * │ 合并语义：content 取保留者的（最新陈述为准）、importance/confidence 取 MAX、
 * │ usage_count 求和、last_used 取最新 —— 保证合并不丢价值标记、不丢使用热度。
 * │ **星型聚类**（只跟簇首比，不做链式传递）：避免 A~B、B~C 一路串成一个大簇，
 * │ 把整个分类合成一条 —— 那是不可逆的数据事故，宁可少合并。
 * │
 * └─ ② 按分类上限淘汰（cap + evict）──────────────────────────────
 *   每个分类设条数上限，超出部分淘汰「价值最低」的行。
 *   **但只淘汰 importance ≤ 4 的行**：用户/模型显式标了高重要度（≥5）的记忆
 *   无论多少条都不删。这条限制让上限成为"低价值行的软上限"，
 *   而不是会误删重要结论的硬闸刀 —— 高重要度行的"别刷屏"职责由
 *   `memory-search.ts` 的分类配额承担（注入侧公平），不与本处职责重叠。
 *
 * 两件事都不调 LLM、纯本地 SQL，所以可以放心挂在后台 worker 上定期跑。
 */

import { rankMemories } from './memory-search'
import { isMemoryCategory, type MemoryCategory } from './memory-category'
import { resolveSnapshotDir, writeMemorySnapshot, discardMemorySnapshot, type MemorySnapshotInfo } from './memory-snapshot'

/** 合并相似度阈值（Jaccard）。0.62 = 词元重合度约 2/3 才判为同一主题 */
export const DEFAULT_MERGE_THRESHOLD = 0.62
/** 少于这么多个"有意义的词元"不参与合并（太短的 key 判不准，容易误合） */
export const DEFAULT_MIN_TOKENS = 2
/** 单簇最大成员数（星型聚类的护栏，双保险防误合并） */
export const DEFAULT_MAX_CLUSTER = 6
/** 可被淘汰的 importance 上限：≥ 此值 +1 的行永不淘汰 */
export const DEFAULT_EVICT_MAX_IMPORTANCE = 4

/**
 * 每个分类的条数上限。设成"大到正常使用永远碰不到、小到失控时一定能刹住"。
 * experience 最紧（它是唯一每任务都可能 +1 的分类）；preference/rule/user 最松
 * （低频、人工味重、几乎不可能靠自动写入撑爆）。
 */
export const CATEGORY_CAP: Record<MemoryCategory, number> = {
  experience: 100,
  general: 60,
  topic: 40,
  knowledge: 150,
  user: 100,
  preference: 100,
  rule: 100,
}

/**
 * 停用词：分类名 / 常见前缀 / 英文虚词。
 *
 * 为什么必须去掉分类名：`经验:` 前缀出现在几乎每一条 experience 的 key 里，
 * 若不去掉，任意两条经验都共享 `经验` 这个词元 → 相似度被凭空抬高，阈值失去意义。
 */
const STOPWORDS = new Set([
  // 分类名与前缀
  '经验', 'experience', 'knowledge', 'preference', 'rule', 'topic', 'user', 'general', 'fact', 'memory', 'mem',
  // 英文虚词 / 高频动词（在 LLM 生成的 problem 句子里必然出现，不携带主题信息）
  'the', 'a', 'an', 'of', 'to', 'and', 'or', 'in', 'on', 'at', 'for', 'with', 'is', 'are', 'was', 'were',
  'be', 'been', 'this', 'that', 'these', 'those', 'it', 'its', 'as', 'by', 'from', 'into', 'about',
  'want', 'wanted', 'wants', 'ask', 'asked', 'asks', 'user', 'please', 'help', 'make', 'made', 'use', 'used', 'using',
])

/**
 * key → 词元集合。
 *
 * 规则：转小写 → 非字母数字汉字一律当分隔符（含 `:` `-` `_` 与中英标点）→ 去停用词 → 去单字符。
 * 中文额外补**字符二元组**：中文无法按空格切词，`整理记忆系统` 与 `整理记忆` 若整串当词元
 * 则完全不相交（相似度 0）；补上 `整理/理记/记忆/忆系/系统` 后二者自然重合到 0.6。
 */
export function keyTokens(key: string): string[] {
  const raw = String(key ?? '').toLowerCase()
  const parts = raw.split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(Boolean)
  const out = new Set<string>()
  for (const p of parts) {
    if (p.length >= 2 && !STOPWORDS.has(p)) out.add(p)
    // 纯中文长串 → 追加字符二元组，解决中文不分词
    if (p.length >= 3 && /^[\u4e00-\u9fa5]+$/.test(p)) {
      for (let i = 0; i + 2 <= p.length; i++) {
        const bg = p.slice(i, i + 2)
        if (!STOPWORDS.has(bg)) out.add(bg)
      }
    }
  }
  return [...out]
}

/** 词元 Jaccard 相似度：|交集| / |并集| ∈ [0,1]；任一侧为空 → 0（不可判 → 不合并） */
export function keySimilarity(a: string, b: string): number {
  const sa = new Set(keyTokens(a))
  const sb = new Set(keyTokens(b))
  if (sa.size === 0 || sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}

export interface MergeGroup {
  category: string
  winnerId: string
  winnerKey: string
  /** 被并入 winner 后删除的行 */
  merged: Array<{ id: string; key: string; similarity: number }>
}

export interface EvictedRow {
  id: string
  key: string
  category: string
  importance: number
  usage_count: number
  created_at: string
}

export interface ConsolidateReport {
  dryRun: boolean
  before: number
  after: number
  mergedGroups: MergeGroup[]
  evicted: EvictedRow[]
  /** 合并 + 淘汰 共减少的行数 */
  removed: number
  /** 合并迭代了几轮才到不动点（>1 说明存在"A~B、B~C 各自成簇"的残留，已内部收敛） */
  mergePasses: number
  /** 动手前落盘的整表快照；dryRun / 内存库时为 null */
  snapshot: MemorySnapshotInfo | null
  /** snapshot 为 null 的原因（给模型/人话摘要用） */
  snapshotSkipped: string
  /** 人话摘要，供工具结果直接回给模型 */
  summary: string
}

export interface ConsolidateOptions {
  mergeThreshold?: number
  minTokens?: number
  maxCluster?: number
  evictMaxImportance?: number
  /** 关掉淘汰（只做合并） */
  noEvict?: boolean
  dryRun?: boolean
  /** 快照目录（默认跟着 DB 文件走；测试传临时目录，免得写进用户真实数据目录） */
  snapshotDir?: string
}

/**
 * 整理一轮。返回报表（dryRun 时不落任何写操作）。
 *
 * 绝不抛错：整理失败只该留下日志，不该影响对话或后台队列。
 */
export function consolidateMemories(db: any, opts: ConsolidateOptions = {}): ConsolidateReport {
  const mergeThreshold = opts.mergeThreshold ?? DEFAULT_MERGE_THRESHOLD
  const minTokens = opts.minTokens ?? DEFAULT_MIN_TOKENS
  const maxCluster = opts.maxCluster ?? DEFAULT_MAX_CLUSTER
  const evictMaxImportance = opts.evictMaxImportance ?? DEFAULT_EVICT_MAX_IMPORTANCE
  const dryRun = !!opts.dryRun

  const report: ConsolidateReport = {
    dryRun, before: 0, after: 0, mergedGroups: [], evicted: [], removed: 0, mergePasses: 0,
    snapshot: null, snapshotSkipped: '', summary: '',
  }

  let rows: any[] = []
  try {
    rows = db.prepare(
      `SELECT id, key, content, category, importance, confidence, usage_count, last_used, role_id, created_at
         FROM agent_memory`,
    ).all() as any[]
  } catch (e: any) {
    report.summary = `整理失败（读取记忆表出错）：${e?.message || e}`
    return report
  }
  report.before = rows.length
  if (rows.length === 0) {
    report.summary = '记忆表为空，无需整理。'
    return report
  }

  // ── ⓪ 动手前先落盘整表快照（P2-2，2026-10-22）──────────────────────
  //
  // 后面的删除全是不可逆的：合并不保留被并入者的 content（只留簇首表述），淘汰直接 DELETE，
  // 都不进回收站也没有 undo。所以非 dryRun 一律先存一份整表。
  // 快照写失败 → **本轮一条都不删**（试算报表照出，人话摘要里说明原因）：
  // 相比"记忆多留一轮"，裸删之后无法恢复是更坏的结果。
  if (!dryRun) {
    const dir = resolveSnapshotDir(db, opts.snapshotDir)
    if (!dir) {
      report.snapshotSkipped = '内存库不落快照（数据本身不持久化）'
    } else {
      try {
        report.snapshot = writeMemorySnapshot(db, dir, 'consolidate')
      } catch (e: any) {
        report.snapshotSkipped = `快照写入失败，本轮未删除任何行：${e?.message || e}`
        report.after = report.before
        report.summary = report.snapshotSkipped
        console.log(`[MemoryConsolidate] ${report.snapshotSkipped}`)
        return report
      }
    }
  }

  const removedIds = new Set<string>()

  // ── ① 合并近似重复（迭代到不动点）───────────────────────────────────
  //
  // 为什么要循环：聚类是**星型**的（同一轮内只跟簇首比，不做链式传递），这带来一个必然残留——
  // 当同一主题的重复行分散成两簇（如 `verified-news-search` 与
  // `cross-verified-news-search` 各自当簇首、各自吸收了自己的重复行），
  // 一轮之后两个簇首**彼此仍然相似**，需要再跑一轮才收敛。
  // 实测真实库：一轮得 209 → 188，复跑还能再合 1 组（188 → 187）。一次整理就该整理到位。
  //
  // ⚠️ 跨轮"接力"有两个必须处理的坑（首版实现两个都踩了，靠真实库端到端验证才发现）：
  //   坑1【统计量陈旧】上一轮的幸存者本轮被当成员吸收时，若仍从最初的快照读它的
  //       importance/usage，就会把上一轮已归并进来的价值标记与使用热度**丢掉**
  //       （实测：幸存者 importance 7 < 被并入的 8、usage 11 ≠ 应有 32）。
  //       → 合并后就地更新内存工作副本，让下一轮读到的是累计值。
  //   坑2【报表自相矛盾】上一轮的幸存者本轮被删，于是它同时以"winner"和"member"两种身份
  //       出现在报告里，还带着一条指向已删行记录。
  //       → 不在轮内拼报告，改为记录"谁被并入了谁"，最后一并沿链回溯到**最终幸存者**归组。
  //
  // MAX_MERGE_PASSES 是保险丝：任何意外的相似度抖动都不该让整理变成死循环。
  const MAX_MERGE_PASSES = 5
  /** 被并入者 id → 吸收它的一方 id（跨轮累计，最后沿链回溯到最终幸存者） */
  const absorbedInto = new Map<string, string>()
  let mergePasses = 0
  try {
    // 内存工作副本：合并后就地更新幸存者统计量，让后续轮次读到累计值（见坑1）
    let working = rows.map((r) => ({ ...r }))
    let pass = 0
    for (; pass < MAX_MERGE_PASSES; pass++) {
      // 按分类分组——绝不跨分类合并（experience 与 knowledge 语义不同，相似也各留各的）
      const byCategory = new Map<string, any[]>()
      for (const r of working) {
        const c = String(r.category ?? 'general')
        if (!byCategory.has(c)) byCategory.set(c, [])
        byCategory.get(c)!.push(r)
      }

      let mergedThisPass = 0

      for (const [category, list] of byCategory) {
        // 簇首选「价值最高」的：复用注入侧同一套打分，保证"留下的就是最该留的"
        const ranked = rankMemories(list)
        const byId = new Map(list.map((r) => [r.id, r]))
        const assigned = new Set<string>()

        for (const seed of ranked) {
          if (assigned.has(seed.id)) continue
          if (keyTokens(seed.key).length < minTokens) { assigned.add(seed.id); continue }

          const members: Array<{ id: string; key: string; similarity: number }> = []
          for (const cand of ranked) {
            if (cand.id === seed.id || assigned.has(cand.id)) continue
            if (members.length >= maxCluster) break
            // 本轮内星型：只跟簇首比，不做 A~B、B~C 的链式传递，避免整类被串成一簇
            const sim = keySimilarity(seed.key, cand.key)
            if (sim >= mergeThreshold) members.push({ id: cand.id, key: cand.key, similarity: sim })
          }

          assigned.add(seed.id)
          if (members.length === 0) continue
          for (const m of members) assigned.add(m.id)
          mergedThisPass += members.length

          // 合并统计量：importance/confidence 取 MAX（不丢价值标记）、usage_count 求和（不丢热度）、
          // last_used 取最新；content 保留簇首的（"关于这个主题的最新陈述为准"）。
          // 注意这里读的是**工作副本的当前值**，因此上一轮归并进来的量会被正确累加。
          const winnerRow = byId.get(seed.id)!
          let importance = Number(winnerRow.importance) || 0
          let confidence = typeof winnerRow.confidence === 'number' ? winnerRow.confidence : 0.5
          let usage = Number(winnerRow.usage_count) || 0
          let lastUsed = winnerRow.last_used || null
          for (const m of members) {
            const r = byId.get(m.id)!
            importance = Math.max(importance, Number(r.importance) || 0)
            confidence = Math.max(confidence, typeof r.confidence === 'number' ? r.confidence : 0)
            usage += Number(r.usage_count) || 0
            const t = r.last_used
            if (t && (!lastUsed || String(t) > String(lastUsed))) lastUsed = t
            absorbedInto.set(m.id, seed.id)
            removedIds.add(m.id)
          }

          // 内存先行（两种模式都要做，否则试算与真实执行的收敛结果会不一致）
          winnerRow.importance = importance
          winnerRow.confidence = confidence
          winnerRow.usage_count = usage
          winnerRow.last_used = lastUsed
          working = working.filter((r) => r.id === seed.id || !removedIds.has(r.id))

          if (dryRun) continue
          db.prepare(
            `UPDATE agent_memory
                SET importance = ?, confidence = ?, usage_count = ?, last_used = ?, updated_at = datetime('now')
              WHERE id = ?`,
          ).run(importance, confidence, usage, lastUsed, seed.id)
          for (const m of members) {
            db.prepare('DELETE FROM agent_memory WHERE id = ?').run(m.id)
          }
        }
      }

      // 这一轮一组都没合上 → 已到不动点
      if (mergedThisPass === 0) break
    }
    mergePasses = Math.min(pass + 1, MAX_MERGE_PASSES)
    // 报告在最后统一拼（见坑2）：把每个被并入者沿链回溯到**最终幸存者**，
    // 相似度按最终幸存者重算（跨轮接手时，轮内那个相似度已不代表与最终幸存者的关系）。
    const aliveIds = new Set(working.map((r) => r.id))
    const rowById = new Map(rows.map((r) => [r.id, r]))
    const finalWinnerOf = (id: string): string | null => {
      let cur = id
      for (let guard = 0; guard < MAX_MERGE_PASSES + 2; guard++) {
        const next = absorbedInto.get(cur)
        if (!next) return cur
        cur = next
      }
      return null // 链异常（理论上不可能）→ 丢弃该条记录，不编造
    }
    const groupByFinalWinner = new Map<string, MergeGroup>()
    for (const memberId of absorbedInto.keys()) {
      const winnerId = finalWinnerOf(memberId)
      if (!winnerId || !aliveIds.has(winnerId)) continue
      let g = groupByFinalWinner.get(winnerId)
      if (!g) {
        const w = rowById.get(winnerId)!
        g = { category: String(w.category ?? 'general'), winnerId, winnerKey: w.key, merged: [] }
        groupByFinalWinner.set(winnerId, g)
        report.mergedGroups.push(g)
      }
      const m = rowById.get(memberId)!
      g.merged.push({ id: memberId, key: m.key, similarity: keySimilarity(g.winnerKey, m.key) })
    }
    report.mergePasses = mergePasses
  } catch (e: any) {
    console.log(`[MemoryConsolidate] 合并阶段出错，已跳过: ${e?.message || e}`)
  }

  // ── ② 按分类上限淘汰低价值行 ──────────────────────────────────────
  if (!opts.noEvict) {
    try {
      const alive = rows.filter((r) => !removedIds.has(r.id))
      const byCategory = new Map<string, any[]>()
      for (const r of alive) {
        const c = String(r.category ?? 'general')
        if (!byCategory.has(c)) byCategory.set(c, [])
        byCategory.get(c)!.push(r)
      }

      for (const [category, list] of byCategory) {
        const cap = isMemoryCategory(category) ? CATEGORY_CAP[category] : CATEGORY_CAP.general
        if (list.length <= cap) continue
        // 按价值排序，从头保留到 cap；超出部分里只有 importance ≤ 阈值的才允许淘汰
        const ranked = rankMemories(list)
        const overflow = ranked.slice(cap).filter((r) => (r.importance ?? 0) <= evictMaxImportance)
        for (const r of overflow) {
          const src = list.find((x) => x.id === r.id)!
          report.evicted.push({
            id: r.id, key: r.key, category,
            importance: r.importance, usage_count: r.usage_count, created_at: src.created_at,
          })
          removedIds.add(r.id)
          if (!dryRun) {
            db.prepare('DELETE FROM agent_memory WHERE id = ?').run(r.id)
          }
        }
      }
    } catch (e: any) {
      console.log(`[MemoryConsolidate] 淘汰阶段出错，已跳过: ${e?.message || e}`)
    }
  }

  report.removed = removedIds.size
  report.after = report.before - report.removed
  // 一条都没删 → 这份快照没有价值，撤掉（否则定期整理的空快照会把有用的挤出去）
  if (report.snapshot && report.removed === 0) {
    discardMemorySnapshot(report.snapshot.path)
    report.snapshot = null
    report.snapshotSkipped = '本轮无删除，未保留快照'
  }
  const mergedCount = report.mergedGroups.reduce((n, g) => n + g.merged.length, 0)
  const parts: string[] = []
  parts.push(`合并 ${report.mergedGroups.length} 组 / 归并 ${mergedCount} 条`)
  parts.push(`淘汰 ${report.evicted.length} 条`)
  parts.push(`总量 ${report.before} → ${report.after}`)
  if (report.snapshot) parts.push(`已备份 ${report.snapshot.rows} 条到 ${report.snapshot.path}`)
  else if (report.snapshotSkipped) parts.push(report.snapshotSkipped)
  report.summary = (dryRun ? '（试算，未落库）' : '') + parts.join('，')
  return report
}
