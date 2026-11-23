/**
 * /api/filesystem/read is how the artifact menu opens a preview. It used to
 * validate against the default sandbox whitelist only, so a file inside the
 * user's own workspace was refused with "path not allowed" and the preview pane
 * stayed empty — the failure was reproduced on Windows, where the workspace root
 * is C:\Users\<name>\…, but the same hole applied on every platform.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import { fsRouter } from './filesystem'

let root: string
let app: Koa

beforeAll(async () => {
  // Deliberately outside both os.tmpdir() and the repo. /tmp, $TEMP and
  // PROJECT_ROOT are all in the default whitelist, so a fixture under any of them
  // passes even when the workspace argument is missing — the test would then be
  // green against the very bug it exists to catch. Only workspaceDir may allow it.
  const base = join(homedir(), `.test-fs-read-${process.pid}`)
  rmSync(base, { recursive: true, force: true })
  root = base
  mkdirSync(join(root, 'out'), { recursive: true })
  writeFileSync(join(root, 'out', 'note.txt'), 'hello from the workspace\n')
  // The gate prefers the most recent session's workspace_dir over the config
  // default, so seed a session pointing here — that is the real lookup path a
  // preview takes, and it is the one that broke on Windows.
  process.env.WORKSPACE_DIR = root
  const { config } = await import('../config')
  config.workspaceDir = root
  const { initDatabase, getDB } = await import('../services/database')
  try { initDatabase() } catch { /* already open in this worker */ }
  const db = getDB()
  db.prepare("INSERT OR REPLACE INTO sessions (id, title, model, created_at, updated_at, workspace_dir) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`fs-read-fixture-${process.pid}`, 'fs read fixture', 'test', new Date().toISOString(), new Date().toISOString(), root)

  app = new Koa()
  app.use(bodyParser())
  app.use(fsRouter.routes()).use(fsRouter.allowedMethods())
})

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
})

const get = (route: string, path: string) => new Promise<{ status: number; body: any }>((resolve) => {
  const server = app.listen(0, () => {
    const port = (server.address() as any).port
    fetch(`http://127.0.0.1:${port}${route}?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const ct = r.headers.get('content-type') || ''
        const body = ct.includes('json') ? await r.json() : { raw: true, size: (await r.arrayBuffer()).byteLength }
        resolve({ status: r.status, body }); server.close()
      })
      .catch((e) => { resolve({ status: 0, body: { error: String(e) } }); server.close() })
  })
})

const read = (path: string) => get('/api/filesystem/read', path)

describe('GET /api/filesystem/read', () => {
  it('reads a file inside the configured workspace', async () => {
    const r = await read(join(root, 'out', 'note.txt'))
    expect(r.body.error).toBeUndefined()
    expect(r.body.content).toContain('hello from the workspace')
  })

  it('reports a missing file instead of an empty pane', async () => {
    const r = await read(join(root, 'out', 'nope.txt'))
    expect(r.body.error).toBeTruthy()
  })

  // /raw serves images and PDFs into the preview pane. It had the same missing
  // workspace argument as /read, so images were unreachable there too.
  it('serves an image from the configured workspace through /raw', async () => {
    // 1x1 transparent PNG
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001' + '0d0a2db40000000049454e44ae426082', 'hex')
    writeFileSync(join(root, 'out', 'dot.png'), png)
    const r = await get('/api/filesystem/raw', join(root, 'out', 'dot.png'))
    expect(r.status).toBe(200)
    expect(r.body.raw).toBe(true)
  })

  it('still refuses credential files', async () => {
    writeFileSync(join(root, 'out', '.env'), 'API_KEY=secret\n')
    const r = await read(join(root, 'out', '.env'))
    expect(r.body.error).toBeTruthy()
    expect(r.body.content).toBeUndefined()
  })
})
