import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import Koa from 'koa'
import request from 'supertest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('../services/database', () => ({ getDB: () => state.db }))
const dir = mkdtempSync(join(tmpdir(), 'upload-persistence-'))
let app: Koa
beforeAll(async () => {
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir)
  try {
    const { uploadRouter } = await import('./upload')
    app = new Koa(); app.use(uploadRouter.routes())
  } finally { cwd.mockRestore() }
})
beforeEach(() => {
  rmSync(join(dir, 'uploads'), { recursive: true, force: true })
  mkdirSync(join(dir, 'uploads'))
  state.db?.close()
  state.db = new Database(':memory:')
  state.db.exec('CREATE TABLE uploads (id TEXT, session_id TEXT, original_name TEXT, stored_name TEXT, mime_type TEXT, size INTEGER, url TEXT)')
})
afterAll(() => { state.db?.close(); rmSync(dir, { recursive: true, force: true }) })

describe('upload persistence', () => {
  it('explains the per-file size limit and removes the partial file', async () => {
    const res = await request(app.callback()).post('/api/upload').attach('files', Buffer.alloc(20 * 1024 * 1024 + 1), 'large.txt')
    expect(res.status).toBe(413)
    expect(res.body.code).toBe('LIMIT_FILE_SIZE')
    expect(readdirSync(join(dir, 'uploads'))).toEqual([])
  })

  it('explains the per-request file count limit and removes the batch', async () => {
    let req = request(app.callback()).post('/api/upload')
    for (let i = 0; i < 6; i++) req = req.attach('files', Buffer.from('x'), `file${i}.txt`)
    const res = await req
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('LIMIT_FILE_COUNT')
    expect(readdirSync(join(dir, 'uploads'))).toEqual([])
  })
  it('rolls back the whole batch and removes files if one insert fails', async () => {
    state.db.exec("CREATE TRIGGER reject_second BEFORE INSERT ON uploads WHEN NEW.original_name = 'bad.txt' BEGIN SELECT RAISE(FAIL, 'test failure'); END")
    const res = await request(app.callback()).post('/api/upload').attach('files', Buffer.from('one'), 'good.txt').attach('files', Buffer.from('two'), 'bad.txt')
    expect(res.status).toBe(500)
    expect(state.db.prepare('SELECT count(*) AS n FROM uploads').get().n).toBe(0)
    expect(readdirSync(join(dir, 'uploads'))).toEqual([])
  })

  it('retains the record and reports an error if the file cannot be deleted', async () => {
    mkdirSync(join(dir, 'uploads', 'not-a-file'))
    state.db.prepare('INSERT INTO uploads (id, stored_name) VALUES (?, ?)').run('one', 'not-a-file')
    const res = await request(app.callback()).delete('/api/upload/one')
    expect(res.status).toBe(500)
    expect(res.body.code).toBe('UPLOAD_DELETE_FAILED')
    expect(state.db.prepare('SELECT count(*) AS n FROM uploads').get().n).toBe(1)
  })
})
