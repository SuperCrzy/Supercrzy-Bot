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
  // Point the gate at this directory, exactly as a real workspace would be.
  process.env.WORKSPACE_DIR = root
  const { config } = await import('../config')
  config.workspaceDir = root

  app = new Koa()
  app.use(bodyParser())
  app.use(fsRouter.routes()).use(fsRouter.allowedMethods())
})

afterAll(() => {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
})

const read = (path: string) => new Promise<{ status: number; body: any }>((resolve) => {
  const server = app.listen(0, () => {
    const port = (server.address() as any).port
    fetch(`http://127.0.0.1:${port}/api/filesystem/read?path=${encodeURIComponent(path)}`)
      .then(async (r) => { resolve({ status: r.status, body: await r.json() }); server.close() })
      .catch((e) => { resolve({ status: 0, body: { error: String(e) } }); server.close() })
  })
})

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

  it('still refuses credential files', async () => {
    writeFileSync(join(root, 'out', '.env'), 'API_KEY=secret\n')
    const r = await read(join(root, 'out', '.env'))
    expect(r.body.error).toBeTruthy()
    expect(r.body.content).toBeUndefined()
  })
})
