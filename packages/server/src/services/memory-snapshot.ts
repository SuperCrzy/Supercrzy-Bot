/**
 * 记忆整理前的落盘快照（P2-2，2026-10-22）
 *
 * 为什么需要：`memory_consolidate` 会**物理删除**记忆行——合并近似重复时删成员行、
 * 按分类上限淘汰低价值行。这些删除不进回收站、不留 undo，一次误合并就是永久丢数据
 * （合并只保留簇首的 content，被并入者的表述直接消失）。
 * 所以每次真实执行（非 dryRun）动手前，必须先把整张表存一份到磁盘。
 *
 * 设计取舍：
 * - **整表快照**，不做"只存将被删的行"——因为删除是分轮次增量发生的（合并 5 轮 + 淘汰），
 *   事前算不出完整集合；而 agent_memory 总量被 CATEGORY_CAP 卡在千行级，整表也就几百 KB。
 * - **快照放在 DB 文件旁边**（`<dbDir>/memory-snapshots/`），而不是用户目录别的角落：
 *   备份跟着它描述的数据走，换机器/换 DB 路径时不会张冠李戴。
 * - **内存库（`:memory:`）不落快照**：这种库本身不持久化，快照无意义，也没有稳定的目录可写。
 * - **保留最近 MAX_SNAPSHOTS 份**，自动清理旧的：整理是定期任务，无限堆积会吃盘。
 * - **绝不抛错**：写失败由调用方决定如何处理（整理那边选择"放弃删除"）。
 *
 * 手工恢复：见 `scripts/diag/restore-memory.mjs`（按 id 补回缺失行，不动现存行）。
 */

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/** 最多保留多少份快照（定期整理默认每 6 小时一次 → 约 5 天） */
export const MAX_SNAPSHOTS = 20
/** 快照文件前缀 */
export const SNAPSHOT_PREFIX = 'memory-'

export interface MemorySnapshotInfo {
  /** 快照文件绝对路径 */
  path: string
  /** 快照里的行数 */
  rows: number
  /** 文件字节数 */
  bytes: number
  /** 生成时刻（ISO） */
  createdAt: string
}

interface SnapshotFile {
  version: 1
  createdAt: string
  reason: string
  rows: any[]
}

/**
 * 快照目录：默认放在 DB 文件同级。
 *
 * 用 `db.name` 而不是 `config.db.path` 判：调用方可能连的是一个测试库/临时库，
 * 快照必须跟着**实际被操作的那个库**走，否则会把测试数据写进用户真实目录。
 * 返回 null = 这个库不该落快照（内存库 / 名字不是普通文件路径）。
 */
export function resolveSnapshotDir(db: any, override?: string): string | null {
  if (override) return override
  const name = typeof db?.name === 'string' ? db.name : ''
  if (!name || name === ':memory:' || name.startsWith('file:')) return null
  return join(dirname(name), 'memory-snapshots')
}

function stamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 把 `agent_memory` 全表写成一个 JSON 快照。
 *
 * 直接 `SELECT *`，不复用调用方的字段投影：快照是"这行原样长什么样"的证据，
 * 少存一列就等于恢复时丢一列（比如 updated_at / role_id）。
 */
export function writeMemorySnapshot(db: any, dir: string, reason = 'consolidate'): MemorySnapshotInfo {
  const rows = db.prepare('SELECT * FROM agent_memory').all() as any[]
  mkdirSync(dir, { recursive: true })
  const createdAt = new Date().toISOString()
  const payload: SnapshotFile = { version: 1, createdAt, reason, rows }
  // 同一秒内重复整理时文件名会撞：加 -2/-3 后缀，绝不覆盖上一份快照
  let path = join(dir, `${SNAPSHOT_PREFIX}${stamp()}-${reason}.json`)
  for (let i = 2; i < 100 && existsSyncSafe(path); i++) {
    path = join(dir, `${SNAPSHOT_PREFIX}${stamp()}-${reason}-${i}.json`)
  }
  writeFileSync(path, JSON.stringify(payload), 'utf8')
  pruneMemorySnapshots(dir)
  return { path, rows: rows.length, bytes: statSync(path).size, createdAt }
}

function existsSyncSafe(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

/** 列出快照，最新的在前 */
export function listMemorySnapshots(dir: string): MemorySnapshotInfo[] {
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.startsWith(SNAPSHOT_PREFIX) && f.endsWith('.json'))
  } catch {
    return []
  }
  const out: MemorySnapshotInfo[] = []
  for (const f of files) {
    const path = join(dir, f)
    try {
      const st = statSync(path)
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as SnapshotFile
      out.push({
        path,
        rows: Array.isArray(parsed.rows) ? parsed.rows.length : 0,
        bytes: st.size,
        createdAt: parsed.createdAt || st.mtime.toISOString(),
      })
    } catch {
      // 坏文件（写到一半断电）不该让列表整体失败
    }
  }
  // 文件名里带时间戳且格式可排序；再按 createdAt 兜一次底
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

/** 只留最新 keep 份，返回删掉的数量 */
export function pruneMemorySnapshots(dir: string, keep = MAX_SNAPSHOTS): number {
  const list = listMemorySnapshots(dir)
  let removed = 0
  for (const item of list.slice(Math.max(0, keep))) {
    try {
      unlinkSync(item.path)
      removed++
    } catch {
      // 删不掉就留着，不因为清理失败影响主流程
    }
  }
  return removed
}

/**
 * 丢掉一份刚写的快照（这次整理一条都没删时调用）。
 *
 * 为什么需要：整理是**定期**任务（后台 worker 每 10 分钟一次，多数轮次无事可做）。
 * 若每轮都留一份快照，20 个名额很快被"什么都没删"的空快照占满，
 * 真正出事那天的有用快照反而被 prune 挤掉 —— 备份等于没有。
 */
export function discardMemorySnapshot(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

export interface RestoreResult {
  /** 补回的行数 */
  inserted: number
  /** 已存在（同 id）而跳过的行数 */
  skipped: number
  /** 快照里的总行数 */
  total: number
}

/**
 * 按 id 把快照里的行补回表中。
 *
 * 语义刻意是**只补不覆盖**（`INSERT OR IGNORE`）：恢复通常是为了找回被误删的行，
 * 现存行可能已经被后续整理改写（合并后的 importance/usage 是累计值），
 * 直接覆盖会把整理成果连同用户的新改动一起冲掉。
 */
export function restoreMemorySnapshot(db: any, snapshotPath: string): RestoreResult {
  const parsed = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SnapshotFile
  const rows = Array.isArray(parsed.rows) ? parsed.rows : []
  const cols = [
    'id', 'key', 'content', 'category', 'importance',
    'created_at', 'updated_at', 'role_id', 'confidence', 'usage_count', 'last_used',
  ]
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO agent_memory (${cols.join(', ')})
     VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  )
  let inserted = 0
  let skipped = 0
  const tx = db.transaction(() => {
    for (const r of rows) {
      const params: Record<string, any> = {}
      for (const c of cols) params[c] = r[c] ?? null
      // key/content 是 NOT NULL：快照缺了也没法补，跳过而不是写空串
      if (params.id == null || params.key == null || params.content == null) { skipped++; continue }
      const info = stmt.run(params)
      if (info.changes > 0) inserted++
      else skipped++
    }
  })
  tx()
  return { inserted, skipped, total: rows.length }
}
