/** Real relay, desktop bridge and chat route with an isolated fake model loop. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { type Server } from 'node:http'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'

const state = vi.hoisted(() => ({ db: null as Database.Database | null, requests: 0, finish: undefined as (() => void) | undefined }))
vi.mock('./database', () => ({ getDB: () => state.db }))
vi.mock('./account-store', () => ({ isSignedIn: () => true, readSession: () => ({ accountId: 'test-account', accessToken: 'test-access', refreshToken: 'test-refresh', deviceId: 'test-device', expiresAt: Date.now() + 300_000 }), currentAccessToken: () => 'test-access', writeSession: () => {}, clearSession: () => {} }))
vi.mock('./agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent')>()
  return { ...actual, runAgentLoop: async (ctx: Koa.Context, _messages: unknown, _config: unknown, _checkpoint: unknown, sessionId: string) => {
    state.requests++
    ctx.res.write('event: content_chunk\ndata: {"text":"partial"}\n\n')
    await new Promise<void>((resolveFinish) => { state.finish = resolveFinish })
    const status = actual.isStopRequested(sessionId) ? 'cancelled' : 'completed'
    ctx.res.write(`event: content\ndata: {"content":"desktop answer"}\n\nevent: task_state\ndata: {"status":"${status}"}\n\nevent: done\ndata: {"finished":true}\n\n`)
    actual.clearStop(sessionId)
  } }
})
import { startRelayClient, stopRelayClient } from './relay-client'
import { requireAccount } from './account-auth'
import { chatRouter } from '../routes/chat'
import { allowsNetworkApi } from './network-access'

const secret = 'test-relay-secret-not-a-production-secret'
const channel = 'test-desktop-workspace'
let relay: ChildProcess
let relayBase: string
let agent: Server
const oldLocalApi = process.env.SUPERCRZY_LOCAL_API
const oldAuthOrigin = process.env.SUPERCRZY_AUTH_ORIGIN

async function waitFor(check: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await check()) return; await new Promise((resolveWait) => setTimeout(resolveWait, 25)) }
  throw new Error('integration condition timed out')
}

beforeAll(async () => {
  state.db = new Database(':memory:')
  state.db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE agent_session_locks (session_id TEXT PRIMARY KEY, owner_pid INTEGER NOT NULL, token TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_dir TEXT, permission_level TEXT, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE custom_models (id TEXT, model_id TEXT, provider_id TEXT, enabled INTEGER);
    CREATE TABLE custom_providers (id TEXT, base_url TEXT, api_key TEXT);`)
  relay = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
    cwd: resolve(process.cwd(), '../relay'), env: { ...process.env, RELAY_HOST: '127.0.0.1', RELAY_PORT: '0', RELAY_SECRET: secret },
    stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  })
  const port = await new Promise<number>((resolvePort, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('test relay startup timed out')), 10_000)
    relay.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); const match = output.match(/listening on :(\d+)/); if (match) { clearTimeout(timer); resolvePort(Number(match[1])) } })
    relay.stderr!.on('data', (chunk: Buffer) => { output += chunk.toString() })
    relay.once('exit', (code) => { clearTimeout(timer); reject(new Error(`test relay exited ${code}: ${output.slice(-500)}`)) })
  })
  relayBase = `http://127.0.0.1:${port}`
  const app = new Koa()
  app.use(bodyParser())
  app.use(async (ctx, next) => {
    if (!allowsNetworkApi({ ip: ctx.ip, origin: ctx.get('origin'), authorization: ctx.get('authorization'), apiToken: '' })) { ctx.status = 401; return }
    return next()
  })
  app.use(requireAccount)
  app.use(chatRouter.routes())
  agent = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolveListen) => agent.once('listening', resolveListen))
  process.env.SUPERCRZY_LOCAL_API = `http://127.0.0.1:${(agent.address() as { port: number }).port}`
  process.env.SUPERCRZY_AUTH_ORIGIN = 'https://auth.supercrzy.com'
  const expiry = Date.now() + 300_000
  const nonce = 'abcdefghijklmnopqrstuv'
  const signature = createHmac('sha256', secret).update(JSON.stringify(['workspace-v1', channel, expiry, nonce])).digest('base64url')
  const settings: Record<string, string> = {
    workspaceAccountId: 'test-account', workspaceAuthOrigin: 'https://auth.supercrzy.com', workspaceChannel: channel,
    workspaceConnectionToken: `v1.${expiry}.${nonce}.${signature}`, workspaceTokenExpiresAt: String(expiry), workspaceRelayUrl: relayBase.replace('http:', 'ws:'),
  }
  const insert = state.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
  for (const [key, value] of Object.entries(settings)) insert.run(key, value)
  startRelayClient()
  await waitFor(async () => {
    const response = await fetch(`${relayBase}/internal/workspaces/status`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channels: [channel] }) })
    return ((await response.json()) as { online: string[] }).online.includes(channel)
  })
})

afterAll(async () => {
  stopRelayClient()
  state.finish?.()
  if (agent) await new Promise<void>((resolveClose) => agent.close(() => resolveClose()))
  if (relay?.pid) { try { if (process.platform === 'win32') relay.kill(); else process.kill(-relay.pid, 'SIGTERM') } catch {} }
  state.db?.close()
  if (oldLocalApi === undefined) delete process.env.SUPERCRZY_LOCAL_API
  else process.env.SUPERCRZY_LOCAL_API = oldLocalApi
  if (oldAuthOrigin === undefined) delete process.env.SUPERCRZY_AUTH_ORIGIN
  else process.env.SUPERCRZY_AUTH_ORIGIN = oldAuthOrigin
})

describe('relay -> desktop task bridge', () => {
  it('executes one request, rejects cross-account work and never replays a duplicate', async () => {
    const publish = (event: unknown, method = 'session/prompt') => fetch(`${relayBase}/internal/publish`, {
      method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, event, method }),
    }).then((res) => res.json())
    const task = { taskId: 'task-1', prompt: 'hello desktop', submittedBy: 'test-account' }
    expect(await publish(task)).toMatchObject({ delivered: true })
    await waitFor(() => state.requests === 1 && !!state.finish)
    expect(await publish(task)).toMatchObject({ delivered: true })
    expect(await publish({ ...task, taskId: 'other', submittedBy: 'another-account' })).toMatchObject({ delivered: true })
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
    expect(state.requests).toBe(1)
    state.finish!()
    state.finish = undefined
    await waitFor(() => (state.db!.prepare("SELECT status FROM remote_bridge_runs WHERE task_id = 'task-1'").get() as { status: string }).status === 'completed')
    expect(state.db!.prepare('SELECT role, content FROM messages ORDER BY rowid').all()).toEqual([
      { role: 'user', content: 'hello desktop' }, { role: 'assistant', content: 'desktop answer' },
    ])
    expect(state.requests).toBe(1)
  })

  it('passes an owned cancellation through the relay to the running chat session', async () => {
    const publish = (event: unknown, method = 'session/prompt') => fetch(`${relayBase}/internal/publish`, {
      method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, event, method }),
    }).then((res) => res.json())
    expect(await publish({ taskId: 'cancel-task', prompt: 'cancel this', submittedBy: 'test-account' })).toMatchObject({ delivered: true })
    await waitFor(() => state.requests === 2 && !!state.finish)
    const row = state.db!.prepare("SELECT session_id FROM remote_bridge_runs WHERE task_id = 'cancel-task'").get() as { session_id: string }
    const { isStopRequested } = await import('./agent')
    expect(await publish({ taskId: 'cancel-task', submittedBy: 'another-account' }, 'session/cancel')).toMatchObject({ delivered: true })
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    expect(isStopRequested(row.session_id)).toBe(false)
    expect(await publish({ taskId: 'cancel-task', submittedBy: 'test-account' }, 'session/cancel')).toMatchObject({ delivered: true })
    await waitFor(() => isStopRequested(row.session_id))
    state.finish!()
    state.finish = undefined
    await waitFor(() => (state.db!.prepare("SELECT status FROM remote_bridge_runs WHERE task_id = 'cancel-task'").get() as { status: string }).status === 'cancelled')
  })
})
