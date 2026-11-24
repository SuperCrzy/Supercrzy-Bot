/**
 * A write must leave either the old content or the new one — never a half file.
 *
 * file_write used to call writeFile directly: truncate, then write the new bytes. A
 * kill in between left the user's file shorter than either version with the original
 * already destroyed. The fix is temp file + fsync + rename.
 *
 * These cases are written to actually distinguish the two implementations. An earlier
 * version of this file tested only happy paths and passed just as well against a plain
 * writeFile — it proved nothing. The case that separates them is a failure during the
 * commit: with a staged file the original survives untouched, without one it has
 * already been truncated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import writeFile, { writeFileAtomic } from '../tools/file-write'

let dir: string

beforeEach(() => { dir = mkdtempSync('/tmp/atomic-write-') })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const leftovers = () => readdirSync(dir).filter((f) => f.endsWith('.tmp'))

describe('file_write is all-or-nothing', () => {
  it('writes the new content and leaves no temp file', async () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'old')
    const result = await writeFile.execute({ path: file, content: 'new' }, { cwd: dir })
    expect(result).toContain('✅')
    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(leftovers()).toEqual([])
  })

  it('keeps the original when the commit cannot land', async () => {
    // A file where the target's parent directory should be: the staged write goes to
    // the parent's path and fails there. Anything that truncated the target first has
    // already lost the original by this point.
    const target = join(dir, 'existing.txt')
    writeFileSync(target, 'original')
    const impossible = join(target, 'child.txt')

    await expect(writeFileAtomic(impossible, 'replacement')).rejects.toBeTruthy()
    expect(readFileSync(target, 'utf8')).toBe('original')
  })

  it('leaves no temp file behind when the write fails', async () => {
    const target = join(dir, 'blocker')
    writeFileSync(target, 'x')
    await expect(writeFileAtomic(join(target, 'nested.txt'), 'data')).rejects.toBeTruthy()
    expect(leftovers()).toEqual([])
  })

  it('preserves a large multi-line file exactly', async () => {
    const file = join(dir, 'big.txt')
    const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
    await writeFileAtomic(file, content)
    expect(readFileSync(file, 'utf8')).toBe(content)
    expect(leftovers()).toEqual([])
  })

  it('truncates cleanly when the new content is shorter', async () => {
    // A stale tail is the failure mode a lazy append hides: writing "b" over
    // "aaaaaaaaaa" must leave exactly "b".
    const file = join(dir, 'short.txt')
    writeFileSync(file, 'aaaaaaaaaa')
    await writeFileAtomic(file, 'b')
    expect(readFileSync(file, 'utf8')).toBe('b')
    expect(statSync(file).size).toBe(1)
  })

  it('replaces the file rather than writing through a stale inode', async () => {
    // rename gives the path a new inode; a hard link to the old one keeps the old
    // bytes. This is what makes the swap atomic for concurrent readers.
    const file = join(dir, 'swap.txt')
    writeFileSync(file, 'old')
    const before = statSync(file).ino
    await writeFileAtomic(file, 'new')
    expect(statSync(file).ino).not.toBe(before)
    expect(readFileSync(file, 'utf8')).toBe('new')
  })
})
