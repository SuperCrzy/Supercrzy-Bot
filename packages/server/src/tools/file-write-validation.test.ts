import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import write from './file-write'

describe('file_write argument validation', () => {
  it('does not change an existing file when content is missing or not text', async () => {
    const dir = mkdtempSync(join('/tmp', 'file-write-validation-'))
    const file = join(dir, 'important.txt')
    try {
      for (const args of [{ path: file }, { path: file, content: null }, { path: file, content: 123 }]) {
        writeFileSync(file, 'original')
        expect(await write.execute(args, { cwd: dir })).toContain('❌')
        expect(readFileSync(file, 'utf8')).toBe('original')
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('allows an explicit empty string when the user intends to empty a file', async () => {
    const dir = mkdtempSync(join('/tmp', 'file-write-validation-'))
    const file = join(dir, 'empty.txt')
    try {
      writeFileSync(file, 'original')
      expect(await write.execute({ path: file, content: '' }, { cwd: dir })).toContain('✅')
      expect(readFileSync(file, 'utf8')).toBe('')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('rejects missing or invalid paths before emitting a file change', async () => {
    let changes = 0
    const ctx = { onFileChange: () => { changes++ } }
    for (const path of [undefined, '', '   ', 42]) {
      expect(await write.execute({ path, content: 'text' }, ctx)).toContain('❌')
    }
    expect(changes).toBe(0)
  })
  it('finishes the complete write even if a progress display callback throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'file-write-progress-'))
    const file = join(dir, 'important.txt')
    const content = Array(30).fill('new line').join('\n')
    try {
      writeFileSync(file, 'original')
      const result = await write.execute({ path: file, content }, {
        cwd: dir, onProgress: () => { throw new Error('simulated interruption') },
      })
      expect(result).toContain('✅')
      expect(readFileSync(file, 'utf8')).toBe(content)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('reports a successful write and warning if post-write notifications fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'file-write-notify-'))
    const file = join(dir, 'page.html')
    let artifacts = 0
    try {
      writeFileSync(file, 'old')
      const result = await write.execute({ path: file, content: '<p>new</p>' }, {
        cwd: dir,
        onPreview: () => { throw new Error('preview failed') },
        onFileChange: () => { throw new Error('change event failed') },
        onArtifacts: () => { artifacts++ },
      })
      expect(result).toContain('✅')
      expect(result).toContain('预览通知失败')
      expect(result).toContain('变更记录通知失败')
      expect(readFileSync(file, 'utf8')).toBe('<p>new</p>')
      expect(artifacts).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  // A single write is still not crash-atomic; a metadata-preserving recovery
  // strategy and a disk-failure test are required before this is enabled.
  it.todo('preserves original content on process crash or partial disk-write failure')
})
