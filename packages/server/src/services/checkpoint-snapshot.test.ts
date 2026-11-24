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
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fileWrite from '../tools/file-write'
import {
  captureSnapshot, appendSnapshotIndex, readSnapshotIndex, readSnapshotText,
  diffLines, restoreSnapshotFile, snapshotDir,
} from './checkpoint-snapshot'

let dir: string
const CID = '11111111-2222-3333-4444-555555555555'

beforeEach(() => { dir = mkdtempSync(join('/tmp', 'snap-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const target = () => join(dir, 'file.txt')

describe('captureSnapshot', () => {
  it.skipIf(process.platform === 'win32')('restricts snapshot directories and files to the current user', () => {
    const first = captureSnapshot(dir, CID, target(), 'after', 'before')!
    appendSnapshotIndex(dir, CID, [first])
    const folder = snapshotDir(dir, CID)
    for (const path of [join(dir, 'snapshots'), folder]) expect(statSync(path).mode & 0o777).toBe(0o700)
    for (const path of [join(folder, `${first.beforeHash}.before`), join(folder, `${first.afterHash}.after`), join(folder, 'index.json')]) expect(statSync(path).mode & 0o777).toBe(0o600)
    chmodSync(folder, 0o755)
    chmodSync(join(folder, 'index.json'), 0o644)
    appendSnapshotIndex(dir, CID, [first])
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    expect(statSync(join(folder, 'index.json')).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('does not overwrite a snapshot path replaced with a symlink', () => {
    const entry = captureSnapshot(dir, CID, target(), 'after', 'before')!
    const snapshotPath = join(snapshotDir(dir, CID), `${entry.afterHash}.after`)
    const other = join(dir, 'other.txt')
    writeFileSync(other, 'keep'); unlinkSync(snapshotPath); symlinkSync(other, snapshotPath)
    expect(captureSnapshot(dir, CID, target(), 'after', 'before')).toBeNull()
    expect(readFileSync(other, 'utf8')).toBe('keep')
  })

  it('treats an existing empty file as existing through the real file-write callback', async () => {
    writeFileSync(target(), '')
    let snapshot: ReturnType<typeof captureSnapshot> = null
    await fileWrite.execute({ path: target(), content: 'new text' }, {
      cwd: dir, permissionLevel: 'workspace-only',
      onFileChange: (path, before, after, existed) => { snapshot = captureSnapshot(dir, CID, path, after, existed ? before : null) },
    })
    expect(snapshot).toMatchObject({ existed: true })
    expect(restoreSnapshotFile(dir, CID, snapshot!)).toMatchObject({ ok: true, action: 'restored' })
    expect(existsSync(target())).toBe(true)
    expect(readFileSync(target(), 'utf8')).toBe('')
  })

  it('captures the actual formatted JSON written to disk', async () => {
    const path = join(dir, 'data.json')
    writeFileSync(path, '{"old":true}')
    let snapshot: ReturnType<typeof captureSnapshot> = null
    await fileWrite.execute({ path, content: '{"next":1}' }, {
      cwd: dir, permissionLevel: 'workspace-only',
      onFileChange: (p, before, after, existed) => { snapshot = captureSnapshot(dir, CID, p, after, existed ? before : null) },
    })
    expect(snapshot).not.toBeNull()
    expect(restoreSnapshotFile(dir, CID, snapshot!)).toMatchObject({ ok: true, action: 'restored' })
    expect(readFileSync(path, 'utf8')).toBe('{"old":true}')
  })

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

  it('refuses a quadratic diff that would exhaust memory', () => {
    expect(() => diffLines('a\n'.repeat(5000), 'b\n'.repeat(5000))).toThrow('diff_too_complex')
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

  it('preserves changes made after the captured task finished', () => {
    const entry = captureSnapshot(dir, CID, target(), 'task result', 'original')!
    writeFileSync(target(), 'user edits')
    expect(restoreSnapshotFile(dir, CID, entry)).toMatchObject({ ok: false, action: 'skipped' })
    expect(readFileSync(target(), 'utf8')).toBe('user edits')
  })

  it('does not delete a newly created file that the user changed later', () => {
    const entry = captureSnapshot(dir, CID, target(), 'task result', null)!
    writeFileSync(target(), 'user edits')
    expect(restoreSnapshotFile(dir, CID, entry)).toMatchObject({ ok: false, action: 'skipped' })
    expect(readFileSync(target(), 'utf8')).toBe('user edits')
  })

  it('refuses a symbolic link substituted after the task', () => {
    const other = join(dir, 'other.txt')
    const entry = captureSnapshot(dir, CID, target(), 'task result', 'original')!
    writeFileSync(other, 'task result'); symlinkSync(other, target())
    expect(restoreSnapshotFile(dir, CID, entry)).toMatchObject({ ok: false, action: 'skipped' })
    expect(readFileSync(other, 'utf8')).toBe('task result')
  })
})
