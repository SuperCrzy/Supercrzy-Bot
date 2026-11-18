import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Koa from 'koa'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import request from 'supertest'
import { writeSession, clearSession } from './account-store'
import { requireAccount } from './account-auth'
import { createTerminalServer, revokeTerminalSessions } from './terminal'
import { terminalRouter } from '../routes/terminal'

let server: Server
let dir: string
let port: number
const originalPort = process.env.PORT

function signIn(accountId = 'test-account') {
  writeSession({ accountId, email: 'test@example.test', deviceId: 'test-device', accessToken: 'local-test', refreshToken: 'local-test', expiresAt: Date.now() + 600_000, savedAt: Date.now() })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'terminal-ticket-test-'))
  process.env.SC_AUTH_DIR = dir
  signIn()
  const app = new Koa()
  app.use(requireAccount)
  app.use(terminalRouter.routes())
  server = createServer(app.callback())
  createTerminalServer(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  process.env.PORT = String(port)
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
  delete process.env.SC_AUTH_DIR
  if (originalPort === undefined) delete process.env.PORT
  else process.env.PORT = originalPort
})

async function handshake(ticket = '', origin = 'http://localhost:5173'): Promise<boolean> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?ticket=${encodeURIComponent(ticket)}`, { origin })
  return new Promise((resolve) => {
    socket.once('open', () => { socket.close(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

describe('terminal WebSocket access', () => {
  it('requires a ticket and rejects replay', async () => {
    expect(await handshake()).toBe(false)
    const response = await request(server).post('/api/terminal/ws-ticket')
    expect(response.status).toBe(200)
    expect(await handshake(response.body.ticket)).toBe(true)
    expect(await handshake(response.body.ticket)).toBe(false)
  })

  it('rejects an untrusted origin and a ticket issued to a previous account', async () => {
    const first = await request(server).post('/api/terminal/ws-ticket')
    expect(await handshake(first.body.ticket, 'https://localhost.evil.com')).toBe(false)
    const second = await request(server).post('/api/terminal/ws-ticket')
    clearSession()
    signIn('different-account')
    expect(await handshake(second.body.ticket)).toBe(false)
  })

  it('accepts a ticket from the current loopback port after port fallback', async () => {
    const response = await request(server).post('/api/terminal/ws-ticket')
    expect(await handshake(response.body.ticket, `http://127.0.0.1:${port}`)).toBe(true)
  })

  it('closes existing terminal connections when the account session is revoked', async () => {
    const response = await request(server).post('/api/terminal/ws-ticket')
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?ticket=${response.body.ticket}`, { origin: 'http://localhost:5173' })
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    const closed = new Promise<number>((resolve) => socket.once('close', resolve))
    revokeTerminalSessions()
    expect(await closed).toBe(1008)
  })
})
