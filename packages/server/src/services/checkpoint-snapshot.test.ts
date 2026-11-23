/**
 * Snapshot capture, diff and restore.
 *
 * The signature takes oldContent from the caller for a reason that cost a debugging
 * round: file_write reports the change after the bytes have landed, so a version of
 * this that read the file itself captured the *new* content on both sides — the
 * index showed identical before/after hashes and rollback silently did nothing.
 * The first test here would have caught that.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureSnapshot, appendSnapshotIndex, readSnapshotIndex, readSnapshotText,
  diffLines, restoreSnapshotFile,
} from './checkpoint-snapshot'

let dir: string
const CID = '11111111-2222-3333-4444-555555555555'

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'snap-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const target = () => join(dir, 'file.txt')

describe('captureSnapshot', () => {
  it('records distinct before and after content', () => {
    writeFileSync(target(), 'old line\n', 'utf8')
    const e = captureSnapshot(dir, CID, target(), 'new line\n', 'old line\n')
    expect(e).not.toBeNull()
    // Same hash on both sides is the bug: it means the before-state was re-read
    // from disk after the write instead of taken from the caller.
    expect(e!.beforeHash).not.toBe(e!.afterHash)
    expect(readSnapshotText(dir, CID, e!.beforeHash!, 'before')).toBe('old line\n')
    expect(readSnapshotText(dir, CID, e!.afterHash!, 'after')).toBe('new line\n')
  })

  it('marks a created file as not previously existing', () => {
    const e = captureSnapshot(dir, CID, target(), 'brand new\n', null)
    expect(e!.existed).toBe(false)
    expect(e!.beforeHash).toBeNull()
  })

  it('keeps the earliest before-state across repeated writes in one checkpoint', () => {
    writeFileSync(target(), 'v1\n', 'utf8')
    const first = captureSnapshot(dir, CID, target(), 'v2\n', 'v1\n')!
    appendSnapshotIndex(dir, CID, [first])
    // A second write in the same turn must not overwrite the original baseline.
    const second = captureSnapshot(dir, CID, target(), 'v3\n', 'v2\n')!
    appendSnapshotIndex(dir, CID, [second])
    const idx = readSnapshotIndex(dir, CID)
    expect(idx.entries).toHaveLength(1)
    expect(readSnapshotText(dir, CID, idx.entries[0].beforeHash!, 'before')).toBe('v1\n')
  })

  it('refuses to snapshot oversized content as text', () => {
    const big = 'x'.repeat(600 * 1024)
    const e = captureSnapshot(dir, CID, target(), big, 'small\n')
    expect(e!.metadataOnly).toBe(true)
    expect(e!.afterHash).toBeNull()
  })

  it('treats content with NUL bytes as binary', () => {
    const e = captureSnapshot(dir, CID, target(), 'a\u0000b', 'plain\n')
    expect(e!.metadataOnly).toBe(true)
  })
})

describe('diffLines', () => {
  it('reports additions and deletions per line', () => {
    const d = diffLines('one\ntwo\n', 'two\nthree\n')
    expect(d.filter((l) => l.type === 'del').map((l) => l.line)).toEqual(['one'])
    expect(d.filter((l) => l.type === 'add').map((l) => l.line)).toEqual(['three'])
    expect(d.some((l) => l.type === 'keep' && l.line === 'two')).toBe(true)
  })

  it('treats an empty original as all additions', () => {
    const d = diffLines('', 'a\nb\n')
    expect(d.filter((l) => l.type === 'add')).toHaveLength(2)
  })
})

describe('restoreSnapshotFile', () => {
  it('brings the previous content back', () => {
    writeFileSync(target(), 'v1\n', 'utf8')
    const e = captureSnapshot(dir, CID, target(), 'v2\n', 'v1\n')!
    writeFileSync(target(), 'v2\n', 'utf8')   // simulate the write that already landed

    const r = restoreSnapshotFile(dir, CID, e)
    expect(r.ok).toBe(true)
    expect(r.action).toBe('restored')
    expect(readFileSync(target(), 'utf8')).toBe('v1\n')
  })

  it('deletes a file that did not exist before the checkpoint', () => {
    const e = captureSnapshot(dir, CID, target(), 'created\n', null)!
    writeFileSync(target(), 'created\n', 'utf8')

    const r = restoreSnapshotFile(dir, CID, e)
    expect(r.ok).toBe(true)
    expect(r.action).toBe('deleted')
    expect(existsSync(target())).toBe(false)
  })

  it('refuses to restore a binary entry instead of writing garbage', () => {
    const e = captureSnapshot(dir, CID, target(), 'x'.repeat(600 * 1024), 'old\n')!
    const r = restoreSnapshotFile(dir, CID, e)
    expect(r.ok).toBe(false)
    expect(r.action).toBe('skipped')
  })
})
