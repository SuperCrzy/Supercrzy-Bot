import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Koa from 'koa'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const relay = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
vi.mock('../services/relay-client', () => ({ startRelayClient: relay.start, stopRelayClient: relay.stop }))
vi.mock('node:child_process', () => ({ spawn: () => ({ on: () => {}, unref: () => {} }) }))

import { accountRouter } from './account'
import { readSession } from '../services/account-store'

let dir: string
const app = new Koa()
app.use(accountRouter.routes())

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'account-relay-test-'))
  process.env.SC_AUTH_DIR = dir
  relay.start.mockClear()
  relay.stop.mockClear()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    accessToken: 'test-access', refreshToken: 'test-refresh', expiresIn: 900,
    account: { id: 'test-account', email: 'test@example.test' }, device: { id: 'test-device' },
  }))))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  delete process.env.SC_AUTH_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('account relay lifecycle', () => {
  it('reports unreadable local account storage without replacing the key', async () => {
    writeFileSync(join(dir, 'auth.json'), 'fixture')
    const response = await request(app.callback()).get('/api/account/status')
    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'account_storage_unavailable' })
  })

  it('distinguishes network, service and local storage failures without reusing login state', async () => {
    const startLogin = async () => (await request(app.callback()).post('/api/account/login/start')).body.state as string
    let state = await startLogin()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network failure with private detail') }))
    let response = await request(app.callback()).get('/auth/callback').query({ state, code: 'test-code' })
    expect(response.status).toBe(502)
    expect(response.text).toContain('无法连接登录服务')
    expect(response.text).not.toContain('private detail')
    expect((await request(app.callback()).get('/auth/callback').query({ state, code: 'test-code' })).status).toBe(400)

    state = await startLogin()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    response = await request(app.callback()).get('/auth/callback').query({ state, code: 'test-code' })
    expect(response.status).toBe(502)
    expect(response.text).toContain('登录服务暂时不可用')

    state = await startLogin()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accessToken: 'a', refreshToken: 'r', account: { id: 'id' } }))))
    const invalidDir = join(dir, 'not-a-directory')
    writeFileSync(invalidDir, 'fixture')
    process.env.SC_AUTH_DIR = invalidDir
    response = await request(app.callback()).get('/auth/callback').query({ state, code: 'test-code' })
    expect(response.status).toBe(500)
    expect(response.text).toContain('无法保存登录状态')
    expect(response.text).not.toContain(invalidDir)
    expect(relay.start).not.toHaveBeenCalled()
  })

  it('does not report a remote request as development-signed-in because its Host is localhost', async () => {
    vi.stubEnv('SUPERCRZY_DEV_NO_AUTH', '1')
    vi.stubEnv('SUPERCRZY_PACKAGED', '0')
    const proxiedApp = new Koa()
    proxiedApp.proxy = true
    proxiedApp.use(accountRouter.routes())
    const local = await request(proxiedApp.callback()).get('/api/account/status').set('Host', 'localhost:3000')
    expect(local.body.signedIn).toBe(true)
    const remote = await request(proxiedApp.callback()).get('/api/account/status').set('Host', 'localhost:3000').set('X-Forwarded-For', '192.0.2.1')
    expect(remote.body.signedIn).toBe(false)
  })

  it('starts after successful login and stops before local logout', async () => {
    const start = await request(app.callback()).post('/api/account/login/start')
    const callback = await request(app.callback()).get('/auth/callback').query({ state: start.body.state, code: 'test-code' })
    expect(callback.status).toBe(200)
    expect(readSession()?.accountId).toBe('test-account')
    expect(relay.start).toHaveBeenCalledTimes(1)
    expect(relay.stop).toHaveBeenCalledTimes(1)
    await request(app.callback()).post('/api/account/logout')
    expect(relay.stop).toHaveBeenCalledTimes(2)
    expect(readSession()).toBeNull()
  })

  it('rejects encryption and sync requests prepared for a different account', async () => {
    const start = await request(app.callback()).post('/api/account/login/start')
    await request(app.callback()).get('/auth/callback').query({ state: start.body.state, code: 'test-code' })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    for (const route of ['/api/account/e2e', '/api/auth-sync/status']) {
      const response = await request(app.callback()).get(route).set('X-Supercrzy-Account', 'old-account')
      expect(response.status).toBe(409)
      expect(response.body.error).toBe('account_changed')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requires the expected account for encrypted writes and never forwards missing or stale requests', async () => {
    const start = await request(app.callback()).post('/api/account/login/start')
    await request(app.callback()).get('/auth/callback').query({ state: start.body.state, code: 'test-code' })
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockClear()
    for (const route of ['/api/account/e2e', '/api/auth-sync/push']) {
      const withoutAccount = route.endsWith('/e2e') ? await request(app.callback()).put(route) : await request(app.callback()).post(route)
      expect(withoutAccount.status).toBe(428)
      expect(withoutAccount.body.error).toBe('account_header_required')
      const stale = route.endsWith('/e2e') ? await request(app.callback()).put(route).set('X-Supercrzy-Account', 'old-account') : await request(app.callback()).post(route).set('X-Supercrzy-Account', 'old-account')
      expect(stale.status).toBe(409)
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await request(app.callback()).post('/api/auth-sync/push').set('X-Supercrzy-Account', 'test-account')).status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
