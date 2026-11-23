import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Koa from 'koa'
import request from 'supertest'

const dir = mkdtempSync(join(tmpdir(), 'upload-preview-'))
let app: Koa
beforeAll(async () => {
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir)
  try {
    const { uploadRouter } = await import('./upload')
    app = new Koa()
    app.use(uploadRouter.routes())
  } finally { cwd.mockRestore() }
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('uploaded file response safety', () => {
  it.each(['html', 'svg', 'js'])('downloads active .%s content without an executable MIME type', async (ext) => {
    writeFileSync(join(dir, 'uploads', `sample.${ext}`), '<script>alert(1)</script>')
    const res = await request(app.callback()).get(`/api/upload/files/sample.${ext}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment')
    expect(res.headers['content-type']).toContain('application/octet-stream')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toContain('sandbox')
  })

  it('retains inline previews for ordinary images and PDFs', async () => {
    for (const ext of ['png', 'pdf']) {
      writeFileSync(join(dir, 'uploads', `sample.${ext}`), 'test')
      const res = await request(app.callback()).get(`/api/upload/files/sample.${ext}`)
      expect(res.status).toBe(200)
      expect(res.headers['content-disposition']).toBe('inline')
    }
  })
})
