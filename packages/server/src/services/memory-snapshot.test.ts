/**
 * memory-snapshot.ts + 「整理前必先落盘」不变量测试（P2-2，2026-10-22）
 *
 * 唯一真正要守的不变量：
 *   **整理过程中被删掉的每一行，都能在快照文件里按 id 找到原文。**
 * 写成"快照文件存在"是没用的（文件存在而内容为空也能过）。
 * 所以下面直接拿"整理前后的 id 差集"当被删集合，逐行去快照里核对。
 *
 * 第二个不变量：快照写失败时**一条都不许删** —— 宁可这轮不整理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureMemoryTable } from './memory-service'
import { consolidateMemories } from './memory-consolidate'
import {
  MAX_SNAPSHOTS,
  listMemorySnapshots,
  pruneMemorySnapshots,
  resolveSnapshotDir,
  restoreMemorySnapshot,
  writeMemorySnapshot,
} from './memory-snapshot'

let db: any
let dir: string

beforeEach(() => {
  db = new (Database as any)(':memory:')
  ensureMemoryTable(db)
  dir = mkdtempSync(join(tmpdir(), 'mem-snap-'))
})

afterEach(() => {
  try { db.close() } catch { /* 已关 */ }
})

function seed(rows: Array<{ id: string; key: string; category?: string; importance?: number; usage?: number }>) {
  const stmt = db.prepare(
    `INSERT INTO agent_memory (id, key, content, category, importance, confidence, usage_count, last_used, role_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  )
  for (const r of rows) {
    stmt.run(
      r.id, r.key, `content of ${r.id}`, r.category ?? 'experience',
      r.importance ?? 5, 0.5, r.usage ?? 0, '2026-09-01 00:00:00', '2026-09-01 00:00:00',
    )
  }
}

const ids = () => (db.prepare('SELECT id FROM agent_memory ORDER BY id').all() as any[]).map((r) => r.id)
const count = () => (db.prepare('SELECT COUNT(*) n FROM agent_memory').get() as any).n

/** 一组必然被合并的近似重复（同分类、key 词元高度重合） */
const dupRows = [
  { id: 'a1', key: '经验:verified-news-search' },
  { id: 'a2', key: '经验:verified-news-search-v2' },
  { id: 'a3', key: '经验:cross-verified-news-search' },
]

describe('被删的每一行都必须能在快照里找回（核心不变量）', () => {
  it('合并删掉的成员行 → 快照里逐行都在，且 content 原文一致', () => {
    seed(dupRows)
    const before = ids()
    const rep = consolidateMemories(db, { snapshotDir: dir })
    const after = ids()
    const deleted = before.filter((id) => !after.includes(id))

    // 前提：这组数据确实触发了删除，否则下面的断言会变成恒真
    expect(deleted.length).toBeGreaterThan(0)
    expect(rep.snapshot, '非 dryRun 必须落快照').not.toBeNull()

    const snap = JSON.parse(readFileSync(rep.snapshot!.path, 'utf8'))
    const snapIds = new Set(snap.rows.map((r: any) => r.id))
    for (const id of deleted) {
      expect(snapIds.has(id), `${id} 被删了但快照里没有 —— 这次删除不可恢复`).toBe(true)
    }
    // content 也要在：只存 id 不能恢复内容
    const lost = snap.rows.find((r: any) => r.id === deleted[0])
    expect(lost.content).toBe(`content of ${deleted[0]}`)
    expect(snap.rows.length).toBe(before.length)
  })

  it('淘汰删掉的行同样在快照里（不只是合并路径）', () => {
    // 塞爆 experience 上限（100），全部 importance=1 → 超出部分会被淘汰
    const rows = Array.from({ length: 108 }, (_, i) => ({
      id: `e${String(i).padStart(3, '0')}`,
      key: `经验:topic-${i}-unique`,
      importance: 1,
    }))
    seed(rows)
    const before = ids()
    const rep = consolidateMemories(db, { snapshotDir: dir, mergeThreshold: 2 }) // 阈值 2 = 不合并，只看淘汰
    const after = ids()
    const deleted = before.filter((id) => !after.includes(id))

    expect(rep.evicted.length).toBeGreaterThan(0)
    expect(deleted.length).toBe(rep.evicted.length)
    const snap = JSON.parse(readFileSync(rep.snapshot!.path, 'utf8'))
    const snapIds = new Set(snap.rows.map((r: any) => r.id))
    for (const id of deleted) expect(snapIds.has(id), `${id} 被淘汰但快照里没有`).toBe(true)
  })
})

describe('dryRun / 内存库 / 快照失败 三种边界', () => {
  it('dryRun 不写快照、不删行', () => {
    seed(dupRows)
    const before = count()
    const rep = consolidateMemories(db, { dryRun: true, snapshotDir: dir })
    expect(rep.snapshot).toBeNull()
    expect(count()).toBe(before)
    expect(readdirSync(dir)).toEqual([])
  })

  it('内存库（没给 snapshotDir）→ 跳过快照但照常整理，并在摘要里说明', () => {
    const memDb = new (Database as any)(':memory:')
    ensureMemoryTable(memDb)
    expect(resolveSnapshotDir(memDb)).toBeNull()
    // 必须有数据，否则整理在读表后就 return 了，压根走不到快照分支（断言会变成恒真）
    memDb.prepare(
      `INSERT INTO agent_memory (id, key, content, category, importance) VALUES (?, ?, ?, 'experience', 5)`,
    ).run('m1', '经验:verified-news-search', 'c1')
    const rep = consolidateMemories(memDb, {})
    expect(rep.before).toBe(1)
    expect(rep.snapshot).toBeNull()
    expect(rep.snapshotSkipped).toContain('内存库')
    expect(rep.summary).toContain('内存库')
    memDb.close()
  })

  it('🔴 快照写不进去 → 一条都不删（宁可这轮不整理）', () => {
    seed(dupRows)
    const before = count()
    // 目录位置被一个普通文件占住 → mkdir 必然失败
    const filePath = join(dir, 'blocker')
    writeFileSync(filePath, 'x')
    const rep = consolidateMemories(db, { snapshotDir: join(filePath, 'sub') })

    expect(rep.snapshot).toBeNull()
    expect(rep.snapshotSkipped).toContain('未删除')
    expect(rep.removed).toBe(0)
    expect(count()).toBe(before)
    expect(rep.after).toBe(before)
  })

  it('🔴 一条都没删就不留快照（否则定期整理的空快照会把有用的挤掉）', () => {
    seed([{ id: 'solo', key: 'pref:solo-key', category: 'preference' }])
    const rep = consolidateMemories(db, { snapshotDir: dir })
    expect(rep.removed).toBe(0)
    expect(rep.snapshot).toBeNull()
    expect(rep.snapshotSkipped).toContain('无删除')
    expect(readdirSync(dir), '没删任何行却留下了快照文件').toEqual([])
  })

  it('默认目录跟着 DB 文件走（文件名里有 db 路径时）', () => {
    const fake = { name: '/Users/x/.supercrzy/data/supercrzy.db' }
    expect(resolveSnapshotDir(fake)).toBe('/Users/x/.supercrzy/data/memory-snapshots')
    // 内存库与 file: URI 都不该落快照
    expect(resolveSnapshotDir({ name: ':memory:' })).toBeNull()
    expect(resolveSnapshotDir({ name: 'file:mem?mode=memory' })).toBeNull()
    expect(resolveSnapshotDir({})).toBeNull()
  })
})

describe('恢复：只补不覆盖', () => {
  it('被合并删掉的行可原样补回，且现存行不被改写', () => {
    seed(dupRows)
    const rep = consolidateMemories(db, { snapshotDir: dir })
    const afterConsolidate = ids()
    const winnerId = afterConsolidate[0]
    const winnerImportance = (db.prepare('SELECT importance FROM agent_memory WHERE id = ?').get(winnerId) as any).importance

    const res = restoreMemorySnapshot(db, rep.snapshot!.path)
    expect(res.inserted).toBeGreaterThan(0)
    // 被删的成员行回来了，content 原文一致
    for (const r of dupRows) {
      const back = db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(r.id) as any
      expect(back, `${r.id} 没恢复回来`).toBeTruthy()
      expect(back.content).toBe(`content of ${r.id}`)
      expect(back.key).toBe(r.key)
    }
    // 幸存者（已带累计 importance）没被快照里的旧值覆盖
    const winnerNow = (db.prepare('SELECT importance FROM agent_memory WHERE id = ?').get(winnerId) as any).importance
    expect(winnerNow).toBe(winnerImportance)
    expect(res.skipped).toBeGreaterThan(0) // 幸存者本来就在 → 跳过
    expect(res.total).toBe(dupRows.length)
  })
})

describe('快照文件管理', () => {
  it('同一秒内连写两份不会互相覆盖', () => {
    seed(dupRows)
    const a = writeMemorySnapshot(db, dir, 'consolidate')
    const b = writeMemorySnapshot(db, dir, 'consolidate')
    expect(a.path).not.toBe(b.path)
    expect(listMemorySnapshots(dir).length).toBe(2)
  })

  it(`最多只留 ${MAX_SNAPSHOTS} 份，旧的自动清掉`, () => {
    seed(dupRows)
    mkdirSync(dir, { recursive: true })
    // 造 25 份"旧"快照（文件名带时间，内容不重要）
    for (let i = 0; i < 25; i++) {
      writeFileSync(
        join(dir, `memory-20200101-0000${String(i).padStart(2, '0')}-old.json`),
        JSON.stringify({ version: 1, createdAt: `2020-01-01T00:00:${String(i).padStart(2, '0')}Z`, reason: 'old', rows: [] }),
      )
    }
    expect(listMemorySnapshots(dir).length).toBe(25)
    const removed = pruneMemorySnapshots(dir, MAX_SNAPSHOTS)
    expect(removed).toBe(5)
    expect(listMemorySnapshots(dir).length).toBe(MAX_SNAPSHOTS)
  })

  it('坏文件不至于让列表整体失败', () => {
    writeFileSync(join(dir, 'memory-20200101-000000-broken.json'), '{not json')
    expect(listMemorySnapshots(dir)).toEqual([])
  })

  it('新快照排在旧的前面', () => {
    seed(dupRows)
    writeFileSync(
      join(dir, 'memory-20200101-000000-old.json'),
      JSON.stringify({ version: 1, createdAt: '2020-01-01T00:00:00Z', reason: 'old', rows: [] }),
    )
    const fresh = writeMemorySnapshot(db, dir, 'consolidate')
    expect(listMemorySnapshots(dir)[0].path).toBe(fresh.path)
  })
})
