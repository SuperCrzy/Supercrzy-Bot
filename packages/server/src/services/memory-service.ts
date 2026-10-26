/**
 * 记忆统一写入入口（2026-09-18）
 *
 * 病灶：改动前有 5 个写入点，各自实现去重与归一，行为互不一致——
 *   - `tools/shared.ts storeMemory`  同 key 同内容跳过 / 同 key 覆盖（默认 importance 3，默认 category 'general'）
 *   - `memory-sync.ts`              同 key 覆盖（importance 取 MAX，打 ISO 时间戳）
 *   - `reflection.ts`               **裸 INSERT，零去重**（每个完成任务无条件 +1 条）
 *   - `agent.ts`（正则抽取）         同 key 覆盖，但 importance 基准不同
 *   - `routes/memory.ts`            校验器单独一张词表（含已废弃的 `fact`）
 *
 * 后果：`experience` 涨到 103 条（占全表 49.5%）且线性增长；库里同时存在 ISO 与 SQL 两种时间格式；
 * 分类脏值（`经验`）被原样注入 system prompt。
 *
 * 现在：**所有写入路径都必须走 `upsertMemory()`**。它负责
 *   ① 归一（key/content 截断、category 归一、importance 收敛 1..10、confidence 0..1）
 *   ② 去重（同 key → 覆盖内容 + importance 取 MAX；同 key 同内容 → 跳过不写）
 *   ③ 统一时间格式（一律 SQL `datetime('now')` == 'YYYY-MM-DD HH:MM:SS'，与表默认值一致）
 *
 * 为什么同 key 一律覆盖内容而不是"保留 importance 高的那条"：
 * 覆盖 = "关于这个 key 的最新陈述为准"，这是偏好/事实类记忆的正确语义
 * （用户改主意时旧值必须让位）。importance 取 MAX 保证高价值标记不被降级。
 */

import { randomUUID } from 'crypto'
import { keySimilarity, keyTokens } from './memory-consolidate'
import { normalizeCategory, normalizeImportance, type MemoryCategory } from './memory-category'

/** key 上限（各写入点原先 60/无限制混用，此处统一） */
export const MAX_MEMORY_KEY = 60
/** content 上限（memory-sync 原 300，reflection 原 ~900，统一放宽到 1000 但设界） */
export const MAX_MEMORY_CONTENT = 1000
/** importance 默认值（原先 3 / 5 混用，统一 5 = "normal"，对齐 reflection 提示词语义） */
export const DEFAULT_MEMORY_IMPORTANCE = 5
/** confidence 默认值（对齐表默认 0.5） */
export const DEFAULT_MEMORY_CONFIDENCE = 0.5

export interface UpsertMemoryInput {
  key: string
  content: string
  category?: string
  importance?: number
  confidence?: number
  /** 角色级隔离（可选；不传则 NULL = 全局记忆） */
  roleId?: string | null
}

export type MemoryUpsertAction = 'inserted' | 'updated' | 'unchanged' | 'rejected' | 'merged'

export interface MemoryUpsertResult {
  action: MemoryUpsertAction
  id: string
  key: string
  category: MemoryCategory
  importance: number
  /** 仅 action==='rejected' 时有值 */
  reason?: string
}

/** 结构最小化的 db 句柄（与既有 `storeMemory(db: any, …)` 一致，避免绑死 better-sqlite3 类型） */
type AnyDb = any

function clampConfidence(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''))
  if (!Number.isFinite(n)) return DEFAULT_MEMORY_CONFIDENCE
  return Math.min(Math.max(n, 0), 1)
}

/**
 * 记忆入库（唯一入口）。绝不抛错——写入失败不该打断对话/反思流程。
 *
 * @returns action：`inserted` 新建 / `updated` 同 key 覆盖 / `unchanged` 同 key 同内容已存在 /
 *          `rejected` 入参非法（空 key 或空 content）
 */
/**
 * 写入侧近似去重阈值（2026-10-26）。
 *
 * 比整理阶段的 0.62 更严（0.75）：写入时合并是主动行为、用户没要求，
 * 误合并的代价比"整理时漏合并"更高。只接"几乎确定是同一件事"的，
 * 激进的改写留给 memory_consolidate 挑。
 */
export const WRITE_SIDE_DEDUPE_THRESHOLD = 0.75

/**
 * 写入侧判定所需的最少词元数（2026-10-26）。
 *
 * 取 4 而不是整理阶段的 2：写入时合并是主动行为，`任务反思:A` / `任务反思:B`
 * 这种短 key 只差一个字符，词元数 2~3，Jaccard 却会冲过 0.75。
 * 4 个词元意味着 key 至少有 2~3 个实词，才足以判断"是不是同一件事"。
 */
export const WRITE_SIDE_DEDUPE_MIN_TOKENS = 4

/**
 * 在**同一分类**内找近似重复条目（写入侧去重用，2026-10-26）。
 *
 * 与 memory-consolidate 共用 `keySimilarity`，但阈值取更保守的一档：
 * 写入时合并是**主动**行为（用户没要求），误合并的代价比"整理时漏合并"更高。
 * 整理阶段仍然是 0.62；这里用 0.75，只接"几乎肯定是同一件事"的情况，
 * 更激进的改写留给整理阶段挑。
 *
 * 返回最相似的那一条（不返回数组）：一条新记忆只该并进一个既有条目，
 * 否则就会出现"新条目同时挂在两个旧条目下"的不一致状态。
 */
function findNearDuplicate(
  db: AnyDb,
  key: string,
  category: string,
): { id: string; key: string; content: string; importance: number } | null {
  let rows: any[]
  try {
    rows = db.prepare(
      'SELECT id, key, content, importance FROM agent_memory WHERE category = ? LIMIT 500',
    ).all(category) as any[]
  } catch {
    return null
  }
  if (rows.length === 0) return null

  // 🔴 词元太少时不做判定（与 memory-consolidate 的 minTokens 护栏同义）。
  // 实测事故：`任务反思:A` 与 `任务反思:B` 词元很少，字符二元组有一半重叠，
  // 相似度轻松越过阈值 —— 三个不同主题被合成一条，那正是记忆库最不能出的错。
  // 短 key 判不准，就干脆不判：宁可多一条重复，也不要少一条信息。
  const tokens = keyTokens(key)
  if (tokens.length < WRITE_SIDE_DEDUPE_MIN_TOKENS) return null

  let best: any = null
  let bestSim = 0
  for (const r of rows) {
    // 候选侧同样要够长，否则「A」这种极短旧条目会吸走所有相似新条目
    if (keyTokens(String(r.key)).length < WRITE_SIDE_DEDUPE_MIN_TOKENS) continue
    const sim = keySimilarity(String(r.key), key)
    if (sim > bestSim) { bestSim = sim; best = r }
  }
  return bestSim >= WRITE_SIDE_DEDUPE_THRESHOLD ? best : null
}

export function upsertMemory(db: AnyDb, input: UpsertMemoryInput): MemoryUpsertResult {
  const key = String(input?.key ?? '').trim().slice(0, MAX_MEMORY_KEY)
  const content = String(input?.content ?? '').trim().slice(0, MAX_MEMORY_CONTENT)
  const category = normalizeCategory(input?.category)
  const importance = normalizeImportance(input?.importance ?? DEFAULT_MEMORY_IMPORTANCE)

  if (!key || !content) {
    return { action: 'rejected', id: '', key, category, importance, reason: key ? 'content 为空' : 'key 为空' }
  }

  try {
    const existing = db.prepare('SELECT id, content, importance FROM agent_memory WHERE key = ? LIMIT 1')
      .get(key) as any

    if (existing) {
      const merged = Math.max(normalizeImportance(existing.importance), importance)
      // 同 key 同内容且 importance 无变化 → 不写库（去重跳过，避免无意义 updated_at 抖动）
      if (String(existing.content) === content && normalizeImportance(existing.importance) === merged) {
        return { action: 'unchanged', id: existing.id, key, category, importance: merged }
      }
      db.prepare(
        `UPDATE agent_memory
            SET content = ?, category = ?, importance = ?, updated_at = datetime('now')
          WHERE id = ?`
      ).run(content, category, merged, existing.id)
      return { action: 'updated', id: existing.id, key, category, importance: merged }
    }

    // 🔴 2026-10-26 新增：写入侧近似去重（对标 WorkBuddy 的"写入时就别产重复"）。
    //
    // 原实现只做**精确 key 匹配**，于是同一件事换个说法就是两条记忆：
    // 「用户偏好中文回答」与「用户喜欢用中文回复」并存，库只会越用越胀。
    // 事后靠 memory_consolidate 整理是补不住的 —— 整理是低频手动动作，
    // 而且它对"内容该不该合并"只能猜（合并会丢掉被并入者的 content）。
    // 在**写入这一侧**拦下，代价最低：不删任何已有数据，只是把新表述并进既有条目。
    //
    // 只在同一分类内比：跨分类的相似 key 往往是真的不同主题
    // （preference 的「用中文」与 experience 的「用中文报错」），不该被合并。
    const nearDup = findNearDuplicate(db, key, category)
    if (nearDup) {
      // content 不同 → 追加（保留两种表述，不丢信息）；相同 → 只抬 importance
      const nextContent = String(nearDup.content) === content
        ? String(nearDup.content)
        : `${nearDup.content}\n${content}`.slice(0, MAX_MEMORY_CONTENT)
      const nextImportance = Math.max(normalizeImportance(nearDup.importance), importance)
      db.prepare(
        `UPDATE agent_memory
            SET content = ?, importance = ?, usage_count = usage_count + 1, updated_at = datetime('now')
          WHERE id = ?`
      ).run(nextContent, nextImportance, nearDup.id)
      return { action: 'merged', id: nearDup.id, key: String(nearDup.key), category, importance: nextImportance }
    }

    const id = randomUUID()
    const confidence = clampConfidence(input?.confidence)
    const roleId = input?.roleId ? String(input.roleId) : null
    db.prepare(
      `INSERT INTO agent_memory
         (id, key, content, category, importance, confidence, role_id, usage_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
    ).run(id, key, content, category, importance, confidence, roleId)
    return { action: 'inserted', id, key, category, importance }
  } catch (e: any) {
    console.log(`[MemoryService] upsert 失败: ${e?.message || e}`)
    return { action: 'rejected', id: '', key, category, importance, reason: e?.message || String(e) }
  }
}

/**
 * 批量入库，返回各条结果（供 memory-sync 这类一次产多条的场景使用）。
 */
export function upsertMemories(db: AnyDb, list: UpsertMemoryInput[]): MemoryUpsertResult[] {
  return (Array.isArray(list) ? list : []).map((m) => upsertMemory(db, m))
}

/**
 * 建表（**仅供测试**：让单测能起一个内存库跑真实 SQL，而不是去 mock SQL 字符串）。
 *
 * ⚠️ 必须与 `services/database.ts` 的 agent_memory DDL 保持一致；新增列时两处同步。
 * 生产路径不走这里（表由 initDatabase 建 + 迁移维护）。
 */
export function ensureMemoryTable(db: AnyDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_memory (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    importance INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    role_id TEXT,
    confidence REAL NOT NULL DEFAULT 0.5,
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used TEXT
  )`)
}
