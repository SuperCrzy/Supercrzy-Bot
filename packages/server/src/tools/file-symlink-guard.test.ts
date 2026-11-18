import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import read from './file-read'
import write from './file-write'

describe('file tools and symlink targets', () => {
  it('does not read or overwrite a sensitive file through an allowed-looking link', async () => {
    const root = mkdtempSync(join(tmpdir(), 'file-guard-'))
    try {
      const privateDir = join(root, '.ssh')
      mkdirSync(privateDir)
      const secret = join(privateDir, 'secret.txt')
      writeFileSync(secret, 'private fixture')
      const link = join(root, 'link.txt')
      symlinkSync(secret, link)
      expect(await read.execute({ path: link }, { cwd: root })).toContain('已拦截')
      expect(await write.execute({ path: link, content: 'overwritten' }, { cwd: root })).toContain('已拦截')
      expect(readFileSync(secret, 'utf8')).toBe('private fixture')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
