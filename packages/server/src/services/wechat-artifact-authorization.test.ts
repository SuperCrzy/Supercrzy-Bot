import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDecipheriv } from 'node:crypto'

const state = vi.hoisted(() => ({ records: new Set<string>() }))
vi.mock('./database', () => ({ getDB: () => ({ prepare: () => ({ get: (session: string, path: string) => state.records.has(JSON.stringify([session, path])) ? { ok: 1 } : undefined }) }) }))
import { sendMediaFileToWeChat } from './wechat-ilink'

const creds = { token: 'token', baseUrl: 'https://example.invalid', accountId: 'a', userId: 'u', savedAt: 0 }
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'wechat-artifact-test-'))
  state.records.clear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

describe('WeChat artifact authorization', () => {
  it('rejects unregistered files and artifacts belonging to another session', async () => {
    const path = join(dir, 'report.txt')
    writeFileSync(path, 'test')
    state.records.add(JSON.stringify(['other', path]))
    expect(await sendMediaFileToWeChat(creds, 'u', 'context', path, undefined, 'current')).toEqual({ success: false, error: 'artifact_not_authorized' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('refuses sensitive targets even when a symlink was registered as an artifact', async () => {
    const target = join(dir, '.env')
    const path = join(dir, 'report.txt')
    writeFileSync(target, 'secret')
    symlinkSync(target, path)
    state.records.add(JSON.stringify(['current', path]))
    expect(await sendMediaFileToWeChat(creds, 'u', 'context', path, undefined, 'current')).toEqual({ success: false, error: 'artifact_not_authorized' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('allows an ordinary registered artifact to reach the upload request', async () => {
    const path = join(dir, 'report.txt')
    writeFileSync(path, 'report')
    state.records.add(JSON.stringify(['current', path]))
    const result = await sendMediaFileToWeChat(creds, 'u', 'context', path, undefined, 'current')
    expect(fetch).toHaveBeenCalledOnce()
    expect(result.success).toBe(false) // the mocked upstream returned 500
  })
  it('encrypts an authorized artifact and sends it through the mocked iLink flow', async () => {
    const path = join(dir, 'report.txt')
    writeFileSync(path, 'verified report')
    state.records.add(JSON.stringify(['current', path]))
    let aesKey = ''
    let uploaded = ''
    let sent = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/getuploadurl')) {
        aesKey = JSON.parse(String(init?.body)).aeskey
        return Response.json({ upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload' })
      }
      if (url === 'https://novac2c.cdn.weixin.qq.com/c2c/upload') {
        expect(init?.redirect).toBe('error')
        const decipher = createDecipheriv('aes-128-ecb', Buffer.from(aesKey, 'hex'), null)
        uploaded = Buffer.concat([decipher.update(init!.body as Uint8Array), decipher.final()]).toString()
        return new Response('', { headers: { 'x-encrypted-param': 'test-param' } })
      }
      if (url.endsWith('/sendmessage')) { sent = true; return Response.json({ ret: 0 }) }
      return new Response('', { status: 404 })
    }))
    expect(await sendMediaFileToWeChat(creds, 'u', 'context', path, undefined, 'current')).toEqual({ success: true })
    expect(uploaded).toBe('verified report')
    expect(sent).toBe(true)
  })
  it('rejects an upload URL outside the trusted CDN', async () => {
    const path = join(dir, 'report.txt')
    writeFileSync(path, 'report')
    state.records.add(JSON.stringify(['current', path]))
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ upload_full_url: 'http://127.0.0.1:3000/internal' })))
    expect(await sendMediaFileToWeChat(creds, 'u', 'context', path, undefined, 'current')).toMatchObject({ success: false, error: 'untrusted_upload_url' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('does not report success when iLink rejects the final send with HTTP 200', async () => {
    const path = join(dir, 'report.txt')
    writeFileSync(path, 'report')
    state.records.add(JSON.stringify(['current', path]))
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/getuploadurl')) return Response.json({ ret: 0, upload_full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/upload' })
      if (url.includes('/c2c/upload')) return new Response('', { headers: { 'x-encrypted-param': 'test-param' } })
      return Response.json({ ret: -1, errmsg: 'private message' })
    }))
    expect(await sendMediaFileToWeChat(creds, 'u', 'context', path, undefined, 'current')).toEqual({ success: false, error: 'ilink_request_rejected' })
  })
})
