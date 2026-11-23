/** Execute the real chat route and agent loop against a local deterministic model. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import type Database from 'better-sqlite3'

const isolation = vi.hoisted(() => ({ root: '' }))
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  return { ...real, homedir: () => isolation.root, default: { ...real, homedir: () => isolation.root } }
})
vi.mock('./memory-worker', () => ({ pushMemorySync: () => {}, pushReflection: () => {} }))

let provider: Server
let chatServer: Server
let db: Database.Database
let baseUrl: string
let remote: typeof import('./remote-task-bridge')
let providerRequests: Array<{ messages?: Array<{ role: string; content: unknown }>; stream?: boolean }> = []
let providerMode: 'answer' | 'file-read' | 'stall' | 'approval' | 'question' | 'disconnect' = 'answer'
let providerDisconnected = false
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

async function waitForTaskLog(text: string): Promise<void> {
  await vi.waitFor(() => {
    const dir = join(isolation.root, '.supercrzy', 'logs')
    const logs = readdirSync(dir).map((file) => readFileSync(join(dir, file), 'utf8')).join('\n')
    expect(logs).toContain(text)
  })
}

beforeAll(async () => {
  isolation.root = mkdtempSync(join(tmpdir(), 'supercrzy-agent-integration-'))
  provider = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      providerRequests.push(JSON.parse(body))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (providerMode === 'disconnect') {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial reply' } }] })}\n\n`)
        setTimeout(() => res.destroy(), 30)
        return
      }
      if (providerMode === 'stall') {
        res.on('close', () => { providerDisconnected = true })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial answer' }, finish_reason: null }] })}\n\n`)
        return
      }
      const toolName = providerMode === 'file-read' ? 'file_read' : providerMode === 'approval' ? 'file_delete' : 'ask_user'
      const toolArgs = providerMode === 'file-read' ? { path: 'input.txt' } : providerMode === 'approval' ? { path: 'protected.txt' } : { question: 'Choose an option', options: [{ label: 'A' }] }
      const delta = ['file-read', 'approval', 'question'].includes(providerMode) && providerRequests.length === 1
        ? { reasoning_content: 'Use the requested tool.', tool_calls: [{ index: 0, id: 'tool-test-1', type: 'function', function: { name: toolName, arguments: JSON.stringify(toolArgs) } }] }
        : { content: providerMode === 'file-read' ? 'Read completed.' : 'Local model answer' }
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>((resolveListen) => provider.listen(0, '127.0.0.1', resolveListen))
  const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}`
  process.env.DB_PATH = join(isolation.root, 'test.db')
  process.env.WORKSPACE_DIR = isolation.root
  process.env.DEEPSEEK_BASE_URL = providerUrl
  process.env.OPENAI_KEY = 'local-test-only'
  process.env.DEEPSEEK_MODEL = 'deepseek-chat'
  const database = await import('./database')
  database.initDatabase()
  db = database.getDB()
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('memoryEnabled', 'false')").run()
  const { chatRouter } = await import('../routes/chat')
  const app = new Koa().use(bodyParser()).use(chatRouter.routes())
  chatServer = app.listen(0, '127.0.0.1')
  await new Promise<void>((resolveListen) => chatServer.once('listening', resolveListen))
  baseUrl = `http://127.0.0.1:${(chatServer.address() as { port: number }).port}`
  // Fail closed if any component unexpectedly attempts an external request.
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith(`${providerUrl}/`) && !url.startsWith(`${baseUrl}/`)) throw new Error('external network disabled for integration test')
    return originalFetch(input, init)
  }) as typeof fetch
  remote = await import('./remote-task-bridge')
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  provider?.closeAllConnections()
  if (chatServer) await new Promise<void>((resolveClose) => chatServer.close(() => resolveClose()))
  if (provider) await new Promise<void>((resolveClose) => provider.close(() => resolveClose()))
  db?.close()
  for (const key of ['DB_PATH', 'WORKSPACE_DIR', 'DEEPSEEK_BASE_URL', 'OPENAI_KEY', 'DEEPSEEK_MODEL']) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
  if (isolation.root) rmSync(isolation.root, { recursive: true, force: true })
})

describe('real agent bridge', () => {
  it('forwards a complete simple chat answer and its DONE marker', async () => {
    providerMode = 'answer'
    try {
      const response = await fetch(`${baseUrl}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'test' }] }), signal: AbortSignal.timeout(5000) })
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain('Local model answer')
      expect(body).toContain('data: [DONE]')
    } finally { providerRequests = [] }
  })

  it('closes the simple chat response without DONE when the upstream disconnects', async () => {
    providerMode = 'disconnect'
    try {
      const response = await fetch(`${baseUrl}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'test' }] }), signal: AbortSignal.timeout(5000) })
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain('Partial reply')
      expect(body).not.toContain('[DONE]')
    } finally { providerMode = 'answer'; providerRequests = [] }
  })

  it('runs the real chat and agent loop, persists the answer, and does not repeat a duplicate', async () => {
    const events: string[] = []
    const input = { db, accountId: 'test-account', taskId: 'real-loop', prompt: 'Hello from the isolated test', baseUrl, onEvent: (event: { type: string }) => events.push(event.type) }
    const result = await remote.runRemoteTask(input)
    expect(result.status).toBe('completed')
    expect(providerRequests).toHaveLength(1)
    expect(providerRequests[0].messages?.some((message) => message.role === 'user' && message.content === input.prompt)).toBe(true)
    expect(db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY rowid').all(result.sessionId)).toEqual([
      { role: 'user', content: input.prompt }, { role: 'assistant', content: 'Local model answer' },
    ])
    expect(events).toContain('completed')
    expect(await remote.runRemoteTask(input)).toMatchObject({ duplicate: true, status: 'completed' })
    expect(providerRequests).toHaveLength(1)
    await waitForTaskLog(input.prompt)
  })

  it('executes a real file-read tool and returns its result to the next model turn', async () => {
    providerRequests = []
    providerMode = 'file-read'
    writeFileSync(join(isolation.root, 'input.txt'), 'isolated fixture contents')
    const events: Array<{ type: string; event?: unknown }> = []
    const result = await remote.runRemoteTask({ db, accountId: 'test-account', taskId: 'tool-loop', prompt: 'Hello, read input.txt', baseUrl, onEvent: (event) => events.push(event) })
    expect(result.status).toBe('completed')
    expect(providerRequests).toHaveLength(2)
    expect(providerRequests[1].messages?.some((message) => message.role === 'tool' && String(message.content).includes('isolated fixture contents'))).toBe(true)
    expect(events.some((event) => event.type === 'sse' && event.event === 'tool_result')).toBe(true)
    expect(db.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'assistant'").get(result.sessionId)).toEqual({ content: 'Read completed.' })
    await waitForTaskLog('Hello, read input.txt')
  })

  it('aborts an in-flight model stream on cancellation without retrying', async () => {
    providerRequests = []
    providerMode = 'stall'
    providerDisconnected = false
    const input = { db, accountId: 'test-account', taskId: 'cancel-model', prompt: 'Hello, cancel this request', baseUrl, onEvent: () => {} }
    const task = remote.runRemoteTask(input)
    await vi.waitFor(() => expect(providerRequests).toHaveLength(1))
    const { requestStop } = await import('./agent')
    expect(remote.cancelRemoteTask(db, input.accountId, input.taskId, requestStop)).toBe(true)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('cancel did not finish')), 4000) })
    const result = await Promise.race([task, deadline]).finally(() => { if (timeout) clearTimeout(timeout) })
    expect(result.status).toBe('cancelled')
    await vi.waitFor(() => expect(providerDisconnected).toBe(true))
    expect(providerRequests).toHaveLength(1)
    expect(await remote.runRemoteTask(input)).toMatchObject({ duplicate: true, status: 'cancelled' })
    await waitForTaskLog(input.prompt)
  })

  it('aborts the planning request when a complex task is cancelled', async () => {
    providerRequests = []
    providerMode = 'stall'
    providerDisconnected = false
    const input = { db, accountId: 'test-account', taskId: 'cancel-plan', prompt: '全面检查这个隔离测试项目', baseUrl, onEvent: () => {} }
    const task = remote.runRemoteTask(input)
    await vi.waitFor(() => expect(providerRequests).toHaveLength(1))
    expect(providerRequests[0].stream).not.toBe(true)
    const { requestStop } = await import('./agent')
    expect(remote.cancelRemoteTask(db, input.accountId, input.taskId, requestStop)).toBe(true)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('planning cancellation timed out')), 4000) })
    const result = await Promise.race([task, deadline]).finally(() => { if (timeout) clearTimeout(timeout) })
    expect(result.status).toBe('cancelled')
    await vi.waitFor(() => expect(providerDisconnected).toBe(true))
    expect(providerRequests).toHaveLength(1)
    await waitForTaskLog(input.prompt)
  })

  it.each(['approval', 'question'] as const)('stops promptly while waiting for %s without executing another model turn', async (mode) => {
    providerRequests = []
    providerMode = mode
    const path = join(isolation.root, 'protected.txt')
    writeFileSync(path, 'do not delete')
    const events: Array<{ type: string; event?: unknown; payload?: unknown }> = []
    const input = { db, accountId: 'test-account', taskId: `cancel-${mode}`, prompt: `Hello, test ${mode}`, baseUrl, onEvent: (event: { type: string; event?: unknown; payload?: unknown }) => events.push(event) }
    const task = remote.runRemoteTask(input)
    await vi.waitFor(() => {
      const expected = mode === 'approval' ? 'tool_call' : 'question'
      const found = events.find((event) => event.event === expected && (mode !== 'approval' || (event.payload as { status?: string })?.status === 'pending'))
      expect(found).toBeTruthy()
    })
    const { requestStop } = await import('./agent')
    expect(remote.cancelRemoteTask(db, input.accountId, input.taskId, requestStop)).toBe(true)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`${mode} cancellation timed out`)), 4000) })
    const result = await Promise.race([task, deadline]).finally(() => { if (timeout) clearTimeout(timeout) })
    expect(result.status).toBe('cancelled')
    expect(providerRequests).toHaveLength(1)
    expect(existsSync(path)).toBe(true)
    await waitForTaskLog(input.prompt)
  })
})
