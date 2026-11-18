import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Koa from 'koa'
import request from 'supertest'

const state = vi.hoisted(() => ({ artifact: null as null | { name: string; path: string; mime: string } }))
vi.mock('../services/database', () => ({ getDB: () => ({ prepare: () => ({ get: () => state.artifact }) }) }))
import { sessionRouter } from './session'

const app = new Koa().use(sessionRouter.routes())
const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); state.artifact = null })

describe('artifact file response isolation', () => {
  it.each(['text/html', 'image/svg+xml'])('sandboxes active %s content without granting the app origin', async (mime) => {
    const dir = mkdtempSync(join(tmpdir(), 'supercrzy-artifact-'))
    paths.push(dir)
    const file = join(dir, 'artifact')
    writeFileSync(file, '<script>fetch("/api/sessions")</script>')
    state.artifact = { name: 'artifact', path: file, mime }
    const response = await request(app.callback()).get('/api/sessions/s1/artifacts/a1/file')
    expect(response.status).toBe(200)
    expect(response.headers['content-security-policy']).toContain('sandbox allow-scripts')
    expect(response.headers['content-security-policy']).not.toContain('allow-same-origin')
    expect(response.headers['content-security-policy']).toContain("default-src 'none'")
    expect(response.headers['content-security-policy']).toContain("form-action 'none'")
    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })
})
