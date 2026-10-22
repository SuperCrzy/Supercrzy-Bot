#!/usr/bin/env node
/**
 * 记忆快照查看 / 恢复（P2-2 配套，2026-10-22）
 *
 * `memory_consolidate` 每次真实执行前会把 agent_memory 整表存成 JSON
 * （位置：<db 所在目录>/memory-snapshots/）。误整理之后用这个脚本找回来。
 *
 * 用法：
 *   node scripts/diag/restore-memory.mjs                    # 列出快照（最新在前）
 *   node scripts/diag/restore-memory.mjs --diff <快照文件>   # 只看会补回哪些行，不写库
 *   node scripts/diag/restore-memory.mjs --restore <快照文件># 真正补回（只补不覆盖）
 *
 * 安全口径：
 * - 默认**只读**，必须显式 --restore 才写库；写之前自动再做一份当前状态快照（可回退）。
 * - 只 INSERT OR IGNORE（按 id）：现存行一律不动，整理后的累计量不会被冲掉。
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import Database from 'better-sqlite3'

function dbPath() {
  const p = process.env.DB_PATH
  if (p && (p.startsWith('/') || p.startsWith('~'))) return p.replace(/^~/, homedir())
  return join(homedir(), '.supercrzy', 'data', 'supercrzy.db')
}

function snapshotDirOf(dbFile) {
  return join(dirname(dbFile), 'memory-snapshots')
}

function human(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function list(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('memory-') || !f.endsWith('.json')) continue
    const path = join(dir, f)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      out.push({
        path,
        rows: Array.isArray(parsed.rows) ? parsed.rows.length : 0,
        createdAt: parsed.createdAt || '',
        reason: parsed.reason || '',
        bytes: statSync(path).size,
        data: parsed.rows || [],
      })
    } catch {
      out.push({ path, rows: -1, createdAt: '', reason: '（文件损坏）', bytes: statSync(path).size, data: [] })
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

const args = process.argv.slice(2)
const dir = snapshotDirOf(dbPath())
const snaps = list(dir)

if (args.length === 0) {
  console.log(`DB      : ${dbPath()}`)
  console.log(`快照目录: ${dir}`)
  if (snaps.length === 0) {
    console.log('\n还没有任何快照（只有真正执行过 memory_consolidate 才会有）。')
    process.exit(0)
  }
  console.log(`\n共 ${snaps.length} 份（最多保留 20 份，旧的自动清）：`)
  for (const s of snaps) {
    console.log(`  ${s.createdAt || '?'}  ${String(s.rows).padStart(5)} 行  ${human(s.bytes).padStart(8)}  ${s.path}`)
  }
  console.log('\n恢复：node scripts/diag/restore-memory.mjs --diff <文件>   先看差异')
  console.log('      node scripts/diag/restore-memory.mjs --restore <文件> 真正补回')
  process.exit(0)
}

const mode = args[0]
const target = args[1] ? resolvePath(args[1]) : ''
if (!['--diff', '--restore', '--list'].includes(mode)) {
  console.error(`未知参数：${mode}（可用 --diff / --restore / 不带参数列出）`)
  process.exit(2)
}
if (mode !== '--list' && !existsSync(target)) {
  console.error(`快照文件不存在：${target}`)
  process.exit(2)
}

const snap = JSON.parse(readFileSync(target, 'utf8'))
const rows = Array.isArray(snap.rows) ? snap.rows : []
const db = new Database(dbPath())
try {
  const existing = new Set(
    db.prepare('SELECT id FROM agent_memory').all().map((r) => r.id),
  )
  const missing = rows.filter((r) => !existing.has(r.id))
  console.log(`快照 ${target}`)
  console.log(`  生成于 ${snap.createdAt || '?'}，共 ${rows.length} 行`)
  console.log(`  当前库已有 ${existing.size} 行；快照里有 ${missing.length} 行在当前库中缺失`)
  if (missing.length === 0) {
    console.log('\n没有缺失行，无需恢复（当前库已包含快照里的全部 id）。')
    process.exit(0)
  }
  console.log('\n缺失的行：')
  for (const r of missing.slice(0, 40)) {
    const snippet = String(r.content ?? '').replace(/\s+/g, ' ').slice(0, 70)
    console.log(`  [${r.category}] importance=${r.importance} ${r.key}\n      ${snippet}`)
  }
  if (missing.length > 40) console.log(`  … 另有 ${missing.length - 40} 行`)

  if (mode === '--diff') {
    console.log('\n（只读模式，未写库。要真正补回请加 --restore）')
    process.exit(0)
  }

  // 写库前先备份当前状态：恢复本身也可能选错快照
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const pre = join(dir, `memory-${stamp}-pre-restore.db.bak`)
  db.close()
  copyFileSync(dbPath(), pre)
  console.log(`\n已备份当前库 → ${pre}`)

  const db2 = new Database(dbPath())
  const cols = [
    'id', 'key', 'content', 'category', 'importance',
    'created_at', 'updated_at', 'role_id', 'confidence', 'usage_count', 'last_used',
  ]
  const stmt = db2.prepare(
    `INSERT OR IGNORE INTO agent_memory (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  )
  let inserted = 0
  const tx = db2.transaction(() => {
    for (const r of rows) {
      const p = {}
      for (const c of cols) p[c] = r[c] ?? null
      if (p.id == null || p.key == null || p.content == null) continue
      if (stmt.run(p).changes > 0) inserted++
    }
  })
  tx()
  const total = db2.prepare('SELECT COUNT(*) n FROM agent_memory').get().n
  console.log(`补回 ${inserted} 行，当前库共 ${total} 行。`)
  db2.close()
} finally {
  try { db.open && db.close() } catch { /* 已关 */ }
}
