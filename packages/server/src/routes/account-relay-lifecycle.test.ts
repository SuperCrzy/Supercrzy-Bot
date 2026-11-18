import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Koa from 'koa'
import request from 'supertest'
import { mkdtempSync, rmSync } from 'node:fs'
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
  delete process.env.SC_AUTH_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('account relay lifecycle', () => {
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
})
