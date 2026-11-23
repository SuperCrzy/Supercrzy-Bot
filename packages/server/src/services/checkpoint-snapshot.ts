/**
 * File snapshots for checkpoints — the piece that makes "restore" mean something.
 *
 * A checkpoint used to record only file names, so restoring one could replay the
 * conversation but not the files: the user saw "5 files changed" and had no way to
 * see what changed or to undo one of them. Diff and single-file rollback both need
 * the bytes, captured *before* the write lands.
 *
 * Storage layout, under <workspace>/data/checkpoints/snapshots/<checkpointId>/:
 *   <hash>.before    original content, missing when the file did not exist
 *   <hash>.after     content as written
 *   index.json       { entries: [{ path, beforeHash, afterHash, existed }] }
 *
 * Binary files are recorded by size only — comparing or restoring a PNG byte-for-byte
 * through a text diff panel is not useful, and storing megabytes per checkpoint is
 * not affordable.
 */
import { chmodSync, closeSync, constants, existsSync, fchmodSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

/** Above this size a file is tracked by size only: snapshots are per checkpoto. */
const MAX_SNAPSHOT_BYTES = 512 * 1024

export interface SnapshotEntry {
  path: string
  /** Hash of the file before the write; null when the file did not exist. */
  beforeHash: string | null
  /** Hash of the content that was written. */
  afterHash: string | null
  existed: boolean
  /** True when the file was too large or not text: diff and rollback are size-only. */
  metadataOnly: boolean
  sizeBefore: number
  sizeAfter: number
}

export interface SnapshotIndex {
  entries: SnapshotEntry[]
}

function hashOf(text: string | Buffer): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

function looksBinary(buf: Buffer): boolean {
  // A NUL byte in the first 8KB is the usual practical tell.
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export function snapshotDir(checkpointDir: string, checkpointId: string): string {
  return join(checkpointDir, 'snapshots', checkpointId)
}

/** Snapshots can contain private source data even when the workspace is shared. */
function ensurePrivateSnapshotDir(checkpointDir: string, checkpointId: string): string {
  const root = join(checkpointDir, 'snapshots')
  const dir = snapshotDir(checkpointDir, checkpointId)
  for (const path of [root, dir]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_snapshot_directory')
    chmodSync(path, 0o700)
  }
  return dir
}

function writePrivateSnapshot(path: string, contents: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600)
  try {
    fchmodSync(fd, 0o600)
    ftruncateSync(fd, 0)
    writeFileSync(fd, contents, 'utf8')
  } finally { closeSync(fd) }
}

/**
 * Record one file write.
 *
 * The caller supplies the previous content rather than this reading it from disk:
 * file_write reports the change *after* the bytes have landed, so reading the file
 * here returns the new content and both sides of the snapshot end up identical —
 * which is exactly the bug this signature prevents. Passing oldContent also makes
 * the function correct regardless of when the caller invokes it.
 *
 * Pass oldContent === null when the file did not exist before (a create).
 */
export function captureSnapshot(
  checkpointDir: string,
  checkpointId: string,
  filePath: string,
  newContent: string,
  oldContent: string | null,
): SnapshotEntry | null {
  try {
    const dir = ensurePrivateSnapshotDir(checkpointDir, checkpointId)

    const existed = oldContent !== null
    const beforeText: string | null = oldContent
    const sizeBefore = existed ? Buffer.byteLength(oldContent!, 'utf8') : 0
    let metadataOnly = false

    // Snapshot text only. Binary cannot be diffed meaningfully in a review panel,
    // and the size gate keeps one large write from bloating every checkpoint.
    if (existed && sizeBefore > MAX_SNAPSHOT_BYTES) metadataOnly = true
    if (beforeText !== null && beforeText.includes('\u0000')) metadataOnly = true
    if (newContent.includes('\u0000')) metadataOnly = true
    if (Buffer.byteLength(newContent, 'utf8') > MAX_SNAPSHOT_BYTES) metadataOnly = true

    const beforeHash = beforeText === null ? null : hashOf(beforeText)
    const afterHash = metadataOnly ? null : hashOf(newContent)

    if (!metadataOnly) {
      if (beforeText !== null && beforeHash) writePrivateSnapshot(join(dir, `${beforeHash}.before`), beforeText)
      if (afterHash) writePrivateSnapshot(join(dir, `${afterHash}.after`), newContent)
    }

    return {
      path: filePath,
      beforeHash,
      afterHash,
      existed,
      metadataOnly,
      sizeBefore,
      sizeAfter: Buffer.byteLength(newContent, 'utf8'),
    }
  } catch {
    return null
  }
}

/** Append entries to the checkpoint's index, replacing any entry for the same path. */
export function appendSnapshotIndex(checkpointDir: string, checkpointId: string, entries: SnapshotEntry[]): void {
  if (entries.length === 0) return
  try {
    const dir = ensurePrivateSnapshotDir(checkpointDir, checkpointId)
    const indexPath = join(dir, 'index.json')
    let index: SnapshotIndex = { entries: [] }
    if (existsSync(indexPath)) {
      try { index = JSON.parse(readFileSync(indexPath, 'utf8')) } catch { index = { entries: [] } }
    }
    const byPath = new Map(index.entries.map((e) => [e.path, e]))
    for (const e of entries) {
      const prev = byPath.get(e.path)
      // Keep the earliest before-state: rolling back should return the file to how
      // it was before this checkpoint touched it, not to an intermediate version.
      byPath.set(e.path, {
        ...e,
        beforeHash: prev ? prev.beforeHash : e.beforeHash,
        existed: prev ? prev.existed : e.existed,
        sizeBefore: prev ? prev.sizeBefore : e.sizeBefore,
      })
    }
    index.entries = [...byPath.values()]
    writePrivateSnapshot(indexPath, JSON.stringify(index, null, 2))
  } catch { /* snapshots are best effort; a failure must not break the task */ }
}

export function readSnapshotIndex(checkpointDir: string, checkpointId: string): SnapshotIndex {
  try {
    const p = join(snapshotDir(checkpointDir, checkpointId), 'index.json')
    if (!existsSync(p)) return { entries: [] }
    return JSON.parse(readFileSync(p, 'utf8')) as SnapshotIndex
  } catch {
    return { entries: [] }
  }
}

export function readSnapshotText(checkpointDir: string, checkpointId: string, hash: string, side: 'before' | 'after'): string | null {
  try {
    const p = join(snapshotDir(checkpointDir, checkpointId), `${hash}.${side}`)
    if (!existsSync(p)) return null
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** Line-level diff, enough for a review panel and cheap to compute. */
export function diffLines(before: string, after: string): Array<{ type: 'keep' | 'add' | 'del'; line: string }> {
  const a = before.split('\n')
  const b = after.split('\n')
  // LCS on lines. Files here are source/text; O(n*m) is fine under the size cap,
  // and a full Myers implementation would be more code than the value it adds.
  const m = a.length, n = b.length
  // A byte limit alone does not bound the number of short lines: without this
  // guard a small text file can allocate a quadratic matrix and exhaust memory.
  if ((m + 1) * (n + 1) > 1_000_000) throw new Error('diff_too_complex')
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: Array<{ type: 'keep' | 'add' | 'del'; line: string }> = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'keep', line: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', line: a[i] }); i++ }
    else { out.push({ type: 'add', line: b[j] }); j++ }
  }
  while (i < m) { out.push({ type: 'del', line: a[i] }); i++ }
  while (j < n) { out.push({ type: 'add', line: b[j] }); j++ }
  return out
}

/**
 * Restore one file from a snapshot.
 *
 * Returns what happened rather than throwing: a partial restore across several
 * files is a normal outcome the caller must be able to report per file.
 */
export function restoreSnapshotFile(
  checkpointDir: string,
  checkpointId: string,
  entry: SnapshotEntry,
): { ok: boolean; action: 'restored' | 'deleted' | 'skipped'; message?: string } {
  try {
    if (entry.metadataOnly) {
      return { ok: false, action: 'skipped', message: '非文本或过大文件只记录大小，无法逐字节还原' }
    }
    if (!entry.afterHash) return { ok: false, action: 'skipped', message: '缺少任务写入后的快照，无法安全回滚' }
    let current
    try { current = lstatSync(entry.path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!entry.existed) return { ok: true, action: 'deleted' }
      return { ok: false, action: 'skipped', message: '文件已不存在，请检查后再回滚' }
    }
    // A symlink or post-task edit is not the version captured in this snapshot.
    if (!current.isFile() || current.isSymbolicLink() || current.size > MAX_SNAPSHOT_BYTES || hashOf(readFileSync(entry.path)) !== entry.afterHash) {
      return { ok: false, action: 'skipped', message: '文件在任务后已更改或不是普通文件，未覆盖；请先检查当前内容' }
    }
    if (!entry.existed) {
      // The file did not exist before this checkpoint, so restoring means removing it.
      if (existsSync(entry.path)) unlinkSync(entry.path)
      return { ok: true, action: 'deleted' }
    }
    if (!entry.beforeHash) {
      return { ok: false, action: 'skipped', message: '缺少原始内容快照' }
    }
    const before = readSnapshotText(checkpointDir, checkpointId, entry.beforeHash, 'before')
    if (before === null) {
      return { ok: false, action: 'skipped', message: '快照文件已丢失' }
    }
    mkdirSync(dirname(entry.path), { recursive: true })
    writeFileSync(entry.path, before, 'utf8')
    return { ok: true, action: 'restored' }
  } catch (e: any) {
    return { ok: false, action: 'skipped', message: e?.message || String(e) }
  }
}
