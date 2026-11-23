import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Koa from 'koa'
import request from 'supertest'
import { appendSnapshotIndex, captureSnapshot } from '../services/checkpoint-snapshot'

const state = vi.hoisted(() => ({ workspaceDir: '' }))
vi.mock('../config', () => ({ config: { get workspaceDir() { return state.workspaceDir } } }))
const id = '11111111-2222-3333-4444-555555555555'
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'checkpoint-route-')); state.workspaceDir = dir; vi.resetModules() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('checkpoint diff safety', () => {
  it('keeps the route usable when one file has too many lines', async () => {
    const checkpointDir = join(dir, 'data', 'checkpoints')
    const large = captureSnapshot(checkpointDir, id, join(dir, 'large.txt'), 'b\n'.repeat(5000), 'a\n'.repeat(5000))!
    const small = captureSnapshot(checkpointDir, id, join(dir, 'small.txt'), 'new', 'old')!
    appendSnapshotIndex(checkpointDir, id, [large, small])
    const { checkpointsRouter } = await import('./checkpoints')
    const app = new Koa(); app.use(checkpointsRouter.routes())
    const response = await request(app.callback()).get(`/api/checkpoints/${id}/diff`)
    expect(response.status).toBe(200)
    expect(response.body.files[0]).toMatchObject({ path: large.path, diffUnavailable: true })
    expect(response.body.files[1]).toMatchObject({ path: small.path, added: 1, deleted: 1 })
  })

  it('does not overwrite a file that changed after its snapshot', async () => {
    const checkpointDir = join(dir, 'data', 'checkpoints')
    const path = join(dir, 'work.txt')
    const entry = captureSnapshot(checkpointDir, id, path, 'task result', 'original')!
    appendSnapshotIndex(checkpointDir, id, [entry]); writeFileSync(path, 'user edits')
    const { checkpointsRouter } = await import('./checkpoints')
    const bodyParser = (await import('koa-bodyparser')).default
    const app = new Koa(); app.use(bodyParser()); app.use(checkpointsRouter.routes())
    const response = await request(app.callback()).post(`/api/checkpoints/${id}/restore`).send({ paths: [path] })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ restored: 0, failed: 1, results: [{ path, ok: false, action: 'skipped' }] })
  })
})
