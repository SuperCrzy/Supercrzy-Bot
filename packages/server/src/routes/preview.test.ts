import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Koa from 'koa'
import request from 'supertest'
import { servePreview } from './preview'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('preview HTTP handler', () => {
  it('serves workspace files but rejects symlink escapes and sensitive targets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supercrzy-preview-http-'))
    dirs.push(dir)
    const root = join(dir, 'workspace')
    const outside = join(dir, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(root, 'safe.txt'), 'visible fixture')
    writeFileSync(join(root, 'secret.key'), 'sensitive fixture')
    writeFileSync(join(outside, 'secret.txt'), 'outside fixture')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'))
    symlinkSync(join(root, 'secret.key'), join(root, 'key-link.txt'))
    symlinkSync(join(root, 'safe.txt'), join(root, 'safe-link.txt'))
    const app = new Koa().use(async (ctx) => { if (ctx.path.startsWith('/api/preview/')) await servePreview(ctx, root) })
    const response = await request(app.callback()).get('/api/preview/safe.txt')
    expect(response.status).toBe(200)
    expect(response.text).toContain('visible fixture')
    expect((await request(app.callback()).get('/api/preview/safe-link.txt')).status).toBe(200)
    for (const path of ['escape.txt', 'key-link.txt']) {
      const denied = await request(app.callback()).get(`/api/preview/${path}`)
      expect(denied.status).toBe(403)
      expect(denied.text).not.toContain('fixture')
    }
    expect((await request(app.callback()).get('/api/preview/missing.txt')).status).toBe(404)
  })
})
