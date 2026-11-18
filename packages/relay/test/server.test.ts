/**
 * End-to-end relay test: pair → claim → connect both ends → forward an envelope
 * each way → verify the allowlist drops unknown methods. Spawns the real server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'
import { createHmac } from 'node:crypto'

let PORT: number
let BASE: string
const TEST_RELAY_SECRET = 'local-test-relay-secret'

let child: ReturnType<typeof spawn>

beforeAll(async () => {
  child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, RELAY_PORT: '0', RELAY_HOST: '127.0.0.1', RELAY_SECRET: TEST_RELAY_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  PORT = await new Promise<number>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${output.slice(-500)}`)), 10_000)
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/listening on :(\d+)/)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
    child.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`relay exited ${code}: ${output.slice(-500)}`)) })
  })
  BASE = `http://127.0.0.1:${PORT}`
})

afterAll(() => {
  try { process.kill(-child.pid!) } catch { /* already gone */ }
})

describe('M8 relay', () => {
  it('pairs, claims, and forwards envelopes both ways', async () => {
    // 1. mobile requests a pairing code + its identity token
    const pairRes = await fetch(`${BASE}/pair`, { method: 'POST' })
    const { code, token: mobileToken } = (await pairRes.json()) as { code: string; token: string }
    expect(code).toMatch(/^\d{6}$/)
    expect(mobileToken).toHaveLength(48)

    // 2. desktop claims it — claim-time is binding-time
    const claimRes = await fetch(`${BASE}/claim`, {
      method: 'POST',
      body: JSON.stringify({ code, deviceName: 'Test Mac' }),
    })
    const { deviceToken } = (await claimRes.json()) as { deviceToken: string }
    expect(deviceToken).toHaveLength(48)
    expect(deviceToken).not.toBe(mobileToken)
    const impersonation = new WebSocket(`ws://127.0.0.1:${PORT}/ws/desktop?dt=${mobileToken}`)
    expect(await new Promise<number>((resolve) => impersonation.once('close', resolve))).toBe(4001)

    // 3. both connect
    const desktop = new WebSocket(`ws://127.0.0.1:${PORT}/ws/desktop?dt=${deviceToken}&name=Test%20Mac`)
    await new Promise((r) => desktop.on('open', r))
    const mobile = new WebSocket(`ws://127.0.0.1:${PORT}/ws/mobile?mt=${mobileToken}`)
    await new Promise((r) => mobile.on('open', r))

    // 4. mobile → desktop (allowed method)
    const got = new Promise<never>((resolve) => {
      desktop.on('message', (raw) => resolve(JSON.parse(String(raw))))
    })
    mobile.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { text: 'hi' } }))
    const received = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no forward')), 3000))])
    expect(received.method).toBe('session/prompt')

    // 5. unknown method is dropped by the allowlist
    let dropped = true
    desktop.on('message', () => { dropped = false })
    mobile.send(JSON.stringify({ method: 'evil/exfil' }))
    await new Promise((r) => setTimeout(r, 500))
    expect(dropped).toBe(true)

    // 6. desktop → mobile (allowed method)
    const gotM = new Promise<never>((resolve) => {
      mobile.on('message', (raw) => resolve(JSON.parse(String(raw))))
    })
    desktop.send(JSON.stringify({ method: 'session/update', params: { delta: 'hello' } }))
    const receivedM = await Promise.race([gotM, new Promise((_, rej) => setTimeout(() => rej(new Error('no forward')), 3000))])
    expect(receivedM.method).toBe('session/update')

    // A temporary desktop disconnect must not destroy the pairing.
    desktop.close()
    await new Promise<void>((resolve) => desktop.once('close', () => resolve()))
    const reconnected = new WebSocket(`ws://127.0.0.1:${PORT}/ws/desktop?dt=${deviceToken}`)
    await new Promise<void>((resolve) => reconnected.once('open', () => resolve()))
    const afterReconnect = new Promise<string>((resolve) => reconnected.once('message', (raw) => resolve(String(raw))))
    mobile.send(JSON.stringify({ method: 'session/prompt', params: { text: 'after reconnect' } }))
    expect(JSON.parse(await afterReconnect)).toMatchObject({ method: 'session/prompt', params: { text: 'after reconnect' } })

    const oversizedClose = new Promise<number>((resolve) => mobile.once('close', resolve))
    mobile.send('x'.repeat(256 * 1024 + 1))
    expect(await oversizedClose).toBe(1009)
    expect((await fetch(`${BASE}/health`)).status).toBe(200)
    reconnected.close()
  }, 20000)

  it('rejects unissued tokens', async () => {
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws/desktop?dt=not-a-token`)
    const code: number = await new Promise((resolve) => bad.on('close', (c) => resolve(c)))
    expect(code).toBe(4001)
  })

  it('authenticates registered workspaces, reports offline, and preserves a newer connection', async () => {
    const channel = 'integration-test-workspace'
    const tokenFor = (expiry: number) => {
      const nonce = 'abcdefghijklmnopqrstuv'
      const signature = createHmac('sha256', TEST_RELAY_SECRET).update(JSON.stringify(['workspace-v1', channel, expiry, nonce])).digest('base64url')
      return `v1.${expiry}.${nonce}.${signature}`
    }
    const token = tokenFor(Date.now() + 120_000)
    const publish = () => fetch(`${BASE}/internal/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_RELAY_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, event: { prompt: 'test task' } }),
    }).then((r) => r.json()) as Promise<{ delivered: boolean; reason?: string }>

    expect(await publish()).toMatchObject({ delivered: false, reason: 'workspace_offline' })
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}/ws/workspace?channel=${channel}&ct=invalid`)
    const rejection = await new Promise<number | undefined>((resolve) => {
      bad.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode) })
      bad.once('error', () => resolve(undefined))
    })
    expect(rejection).toBe(401)
    for (const invalidToken of [tokenFor(Date.now() - 1), createHmac('sha256', TEST_RELAY_SECRET).update(channel).digest('base64url')]) {
      const invalidSocket = new WebSocket(`ws://127.0.0.1:${PORT}/ws/workspace?channel=${channel}&ct=${invalidToken}`)
      const status = await new Promise<number | undefined>((resolve) => {
        invalidSocket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode) })
        invalidSocket.once('error', () => resolve(undefined))
      })
      expect(status).toBe(401)
    }
    const expiresSoon = new WebSocket(`ws://127.0.0.1:${PORT}/ws/workspace?channel=${channel}&ct=${tokenFor(Date.now() + 300)}`)
    await new Promise<void>((resolve, reject) => { expiresSoon.once('open', resolve); expiresSoon.once('error', reject) })
    expect(await new Promise<number>((resolve) => expiresSoon.once('close', resolve))).toBe(4004)
    const connect = async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws/workspace?channel=${channel}&ct=${token}`)
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      return socket
    }
    const first = await connect()
    const second = await connect()
    first.close()
    await new Promise<void>((resolve) => first.once('close', () => resolve()))
    const status = await fetch(`${BASE}/internal/workspaces/status`, {
      method: 'POST', headers: { Authorization: `Bearer ${TEST_RELAY_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels: [channel, 'offline'] }),
    })
    expect(await status.json()).toEqual({ online: [channel] })
    expect((await fetch(`${BASE}/internal/workspaces/status`, { method: 'POST', body: JSON.stringify({ channels: [channel] }) })).status).toBe(401)
    const received = new Promise<string>((resolve) => second.once('message', (raw) => resolve(String(raw))))
    expect(await publish()).toMatchObject({ delivered: true })
    expect(JSON.parse(await received)).toMatchObject({ method: 'session/prompt', params: { prompt: 'test task' } })
    const cancelled = new Promise<string>((resolve) => second.once('message', (raw) => resolve(String(raw))))
    const cancelResponse = await fetch(`${BASE}/internal/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_RELAY_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, method: 'session/cancel', event: { taskId: 'task-1' } }),
    })
    expect(await cancelResponse.json()).toMatchObject({ delivered: true })
    expect(JSON.parse(await cancelled)).toMatchObject({ method: 'session/cancel', params: { taskId: 'task-1' } })
    const invalid = await fetch(`${BASE}/internal/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_RELAY_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, method: 'evil/exfil' }),
    })
    expect(invalid.status).toBe(400)
    second.close()
    await new Promise<void>((resolve) => second.once('close', () => resolve()))
    expect(await publish()).toMatchObject({ delivered: false })
    const offline = await fetch(`${BASE}/internal/workspaces/status`, {
      method: 'POST', headers: { Authorization: `Bearer ${TEST_RELAY_SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channels: [channel] }),
    })
    expect(await offline.json()).toEqual({ online: [] })
  })

  it('limits claim body size and repeated pairing guesses', async () => {
    const tooLarge = await fetch(`${BASE}/claim`, { method: 'POST', body: 'x'.repeat(4096) })
    expect(tooLarge.status).toBe(413)
    const statuses: number[] = []
    for (let i = 0; i < 11; i++) statuses.push((await fetch(`${BASE}/claim`, { method: 'POST', body: JSON.stringify({ code: '000000' }) })).status)
    expect(statuses).toContain(429)
  })

  it('limits authenticated internal request bodies', async () => {
    const headers = { Authorization: `Bearer ${TEST_RELAY_SECRET}`, 'Content-Type': 'application/json' }
    expect((await fetch(`${BASE}/internal/publish`, { method: 'POST', headers, body: 'x'.repeat(270 * 1024) })).status).toBe(413)
    expect((await fetch(`${BASE}/internal/workspaces/status`, { method: 'POST', headers, body: 'x'.repeat(33 * 1024) })).status).toBe(413)
    expect((await fetch(`${BASE}/health`)).status).toBe(200)
  })
})
