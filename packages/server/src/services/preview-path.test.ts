import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePreviewPath } from './preview-path'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('preview path boundary', () => {
  it('allows ordinary files and links within the workspace, but rejects escapes and sensitive targets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supercrzy-preview-'))
    dirs.push(dir)
    const root = join(dir, 'workspace')
    const outside = join(dir, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(root, 'readme.txt'), 'safe')
    writeFileSync(join(root, 'private.key'), 'sensitive')
    writeFileSync(join(outside, 'secret.txt'), 'outside')
    symlinkSync(join(root, 'readme.txt'), join(root, 'safe-link.txt'))
    symlinkSync(join(root, 'private.key'), join(root, 'hidden-key.txt'))
    symlinkSync(join(outside, 'secret.txt'), join(root, 'outside-link.txt'))
    symlinkSync(outside, join(root, 'outside-dir'))
    expect(await resolvePreviewPath(root, 'readme.txt')).toEqual({ ok: true, path: await realpath(join(root, 'readme.txt')) })
    expect(await resolvePreviewPath(root, 'safe-link.txt')).toEqual({ ok: true, path: await realpath(join(root, 'readme.txt')) })
    for (const name of ['outside-link.txt', 'outside-dir/secret.txt', 'hidden-key.txt', '../outside/secret.txt', 'private.key']) {
      expect(await resolvePreviewPath(root, name), name).toEqual({ ok: false, reason: 'forbidden' })
    }
    expect(await resolvePreviewPath(root, 'missing.txt')).toEqual({ ok: false, reason: 'not_found' })
  })
})
