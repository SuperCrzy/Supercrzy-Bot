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
let providerMode: 'answer' | 'file-read' | 'goal-continue' | 'bad-args' | 'stall' | 'approval' | 'question' | 'disconnect' = 'answer'
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
      const isRead = providerMode === 'file-read' || providerMode === 'goal-continue' || providerMode === 'bad-args'
      const toolName = isRead ? 'file_read' : providerMode === 'approval' ? 'file_delete' : 'ask_user'
      const toolArgs = isRead ? { path: 'input.txt' } : providerMode === 'approval' ? { path: 'protected.txt' } : { question: 'Choose an option', options: [{ label: 'A' }] }
      const delta = ['file-read', 'goal-continue', 'bad-args', 'approval', 'question'].includes(providerMode) && providerRequests.length === 1
        ? { reasoning_content: 'Use the requested tool.', tool_calls: [{ index: 0, id: 'tool-test-1', type: 'function', function: { name: toolName, arguments: providerMode === 'bad-args' ? '{' : JSON.stringify(toolArgs) } }] }
        : { content: ['goal-continue', 'bad-args'].includes(providerMode) && providerRequests.length === 2 ? '已读取文件。\n<goal_report>{"action":"continue","evidence_call_ids":["tool-test-1"]}</goal_report>' : providerMode === 'file-read' ? 'Read completed.' : 'Local model answer' }
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
    if (!url.startsWith(`${providerUrl}/`) && !url.startsWith(`${baseUrl}/`) && !(process.env.SC_TEST_LIVE_GOAL === '1' && url.startsWith('https://api.deepseek.com/'))) throw new Error('external network disabled for integration test')
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
  it.skipIf(process.env.SC_TEST_LIVE_GOAL !== '1')('continues a two-stage read-only goal against a live model', async () => {
    const Database = (await import('better-sqlite3')).default
    const sourcePath = process.env.SC_TEST_SOURCE_DB
    if (!sourcePath) throw new Error('SC_TEST_SOURCE_DB is required for the opt-in live test')
    const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
    const apiKey = (source.prepare("SELECT value FROM settings WHERE key = 'apiKey'").get() as { value?: string } | undefined)?.value
    source.close()
    if (!apiKey) throw new Error('live model key unavailable')
    const providerId = 'goal-live-provider', modelId = 'a1111111-1111-4111-8111-111111111111'
    db.prepare('INSERT INTO custom_providers (id, name, provider_key, base_url, api_key) VALUES (?, ?, ?, ?, ?)').run(providerId, 'Goal QA', providerId, 'https://api.deepseek.com', apiKey)
    db.prepare('INSERT INTO custom_models (id, provider_id, model_id, display_name) VALUES (?, ?, ?, ?)').run(modelId, providerId, 'deepseek-v4-pro', 'Goal QA')
    writeFileSync(join(isolation.root, 'first.txt'), 'FIRST_MARKER=ALPHA_521')
    writeFileSync(join(isolation.root, 'second.txt'), 'SECOND_MARKER=BETA_672')
    db.prepare('INSERT INTO sessions (id, title, workspace_dir, permission_level) VALUES (?, ?, ?, ?)').run('goal-live-qa', 'Goal QA', isolation.root, 'workspace-only')
    const { createPersistentGoal, getOpenPersistentGoal, listGoalEvents } = await import('./persistent-goals')
    const { createGoalRuntime } = await import('./goal-runtime')
    const { handleAgentChat } = await import('./chat')
    const { requestStop } = await import('./agent')
    const goal = createPersistentGoal(db, 'goal-live-qa', '只读测试：分两轮读取 first.txt 和 second.txt。没有上轮结果时只用 file_read 读取 first.txt 并结束本轮；有上轮结果后再读取 second.txt 并汇总。禁止写入、命令或其他操作。')
    const runtime = createGoalRuntime(db, { handler: handleAgentChat, requestStop, currentAccount: () => 'test-account' })
    await runtime.start('goal-live-qa', goal.id, goal.version, { model: modelId, language: 'zh-CN' })!.completion
    await waitForTaskLog('只读测试')
    const events: ReturnType<typeof listGoalEvents> = []
    for (let cursor = 0, page = 0; page < 100; page++) {
      const batch = listGoalEvents(db, 'goal-live-qa', goal.id, cursor)
      events.push(...batch)
      if (batch.length < 100) break
      cursor = batch[batch.length - 1].sequence
    }
    const saved = getOpenPersistentGoal(db, 'goal-live-qa')
    const diagnostic = { status: saved?.status, eventCount: events.length, toolNames: events.filter(event => event.event === 'tool_call').map(event => (event.payload as any).name), hasExpectedMarker: !!saved?.last_result.includes('BETA_672') }
    const turn = events.find(event => event.event === 'goal_turn')
    expect(turn, JSON.stringify(diagnostic)).toBeDefined()
    const reads = events.filter(event => event.event === 'tool_call' && (event.payload as any).name === 'file_read')
    const readFor = (file: string) => reads.find(event => {
      try { return String(JSON.parse(String((event.payload as any).arguments)).path || '').split('/').at(-1) === file } catch { return false }
    })
    const first = readFor('first.txt'), second = readFor('second.txt')
    expect(first, JSON.stringify(diagnostic)).toBeDefined()
    expect(second, JSON.stringify(diagnostic)).toBeDefined()
    expect(first!.sequence).toBeLessThan(turn!.sequence)
    expect(second!.sequence).toBeGreaterThan(turn!.sequence)
    for (const [call, marker] of [[first, 'ALPHA_521'], [second, 'BETA_672']] as const) {
      const result = events.find(event => event.event === 'tool_result' && (event.payload as any).tool_call_id === (call!.payload as any).id)
      expect(String((result?.payload as any)?.content || '')).toContain(marker)
    }
    expect(saved?.last_result).toContain('BETA_672')
  }, 90000)
  it('does not continue a goal when the real dispatcher rejects malformed tool arguments', async () => {
    providerRequests = []
    providerMode = 'bad-args'
    db.prepare('INSERT INTO sessions (id, title, workspace_dir) VALUES (?, ?, ?)').run('goal-bad-args', 'Goal', isolation.root)
    const { createPersistentGoal, getOpenPersistentGoal, listGoalEvents } = await import('./persistent-goals')
    const { createGoalRuntime } = await import('./goal-runtime')
    const { handleAgentChat } = await import('./chat')
    const { requestStop } = await import('./agent')
    const goal = createPersistentGoal(db, 'goal-bad-args', 'Hello inspect file')
    const runtime = createGoalRuntime(db, { handler: handleAgentChat, requestStop, currentAccount: () => 'test-account' })
    try {
      await runtime.start('goal-bad-args', goal.id, goal.version)!.completion
      const events = listGoalEvents(db, 'goal-bad-args', goal.id, 0)
      expect(events.find(event => event.event === 'tool_result')?.payload).toMatchObject({ status: 'error', tool_call_id: 'tool-test-1' })
      expect(events.some(event => event.event === 'goal_turn')).toBe(false)
      expect(getOpenPersistentGoal(db, 'goal-bad-args')).toMatchObject({ status: 'paused', last_result: expect.stringContaining('本轮有工具执行失败或未执行') })
      expect(providerRequests).toHaveLength(2)
      await waitForTaskLog('Hello inspect file')
    } finally { providerMode = 'answer'; providerRequests = [] }
  })
  it('automatically advances a goal only after observed successful tool evidence', async () => {
    providerRequests = []
    providerMode = 'goal-continue'
    writeFileSync(join(isolation.root, 'input.txt'), 'isolated fixture contents')
    db.prepare('INSERT INTO sessions (id, title, workspace_dir) VALUES (?, ?, ?)').run('goal-auto', 'Goal', isolation.root)
    const { createPersistentGoal, getOpenPersistentGoal, listGoalEvents } = await import('./persistent-goals')
    const { createGoalRuntime } = await import('./goal-runtime')
    const { handleAgentChat } = await import('./chat')
    const { requestStop } = await import('./agent')
    const goal = createPersistentGoal(db, 'goal-auto', 'Hello read input.txt')
    const runtime = createGoalRuntime(db, { handler: handleAgentChat, requestStop, currentAccount: () => 'test-account' })
    try {
      await runtime.start('goal-auto', goal.id, goal.version)!.completion
      expect(providerRequests).toHaveLength(3)
      expect(providerRequests[1].messages?.some(message => message.role === 'system' && String(message.content).includes('tool-test-1'))).toBe(true)
      expect(providerRequests[2].messages?.some(message => String(message.content).includes('已读取文件'))).toBe(true)
      expect(listGoalEvents(db, 'goal-auto', goal.id, 0).some(event => event.event === 'goal_turn')).toBe(true)
      expect(getOpenPersistentGoal(db, 'goal-auto')).toMatchObject({ status: 'paused', last_result: 'Local model answer' })
      await waitForTaskLog('Hello read input.txt')
    } finally { providerMode = 'answer'; providerRequests = [] }
  })
  it('runs a persistent goal through the real Agent loop with a local model', async () => {
    providerRequests = []
    providerMode = 'answer'
    db.prepare("INSERT INTO sessions (id, title) VALUES ('goal-real-loop', 'Goal')").run()
    const { createPersistentGoal, getOpenPersistentGoal, listGoalEvents } = await import('./persistent-goals')
    const { createGoalRuntime } = await import('./goal-runtime')
    const { handleAgentChat } = await import('./chat')
    const { requestStop } = await import('./agent')
    const goal = createPersistentGoal(db, 'goal-real-loop', '测试目标', '保留证据')
    const runtime = createGoalRuntime(db, { handler: handleAgentChat, requestStop, currentAccount: () => 'test-account' })
    await runtime.start('goal-real-loop', goal.id, goal.version)!.completion
    expect(providerRequests.length).toBeGreaterThan(0)
    expect(providerRequests.some(r => r.messages?.some(m => m.role === 'user' && String(m.content).includes('测试目标')))).toBe(true)
    expect(getOpenPersistentGoal(db, 'goal-real-loop')).toMatchObject({ status: 'paused', last_result: 'Local model answer' })
    expect(listGoalEvents(db, 'goal-real-loop', goal.id, 0).some(e => e.event === 'done')).toBe(true)
    await waitForTaskLog('测试目标')
  })

  it('stops a persistent goal that is waiting on the local model', async () => {
    providerRequests = []
    providerMode = 'stall'
    providerDisconnected = false
    db.prepare("INSERT INTO sessions (id, title) VALUES ('goal-pause-loop', 'Goal')").run()
    const { createPersistentGoal, getOpenPersistentGoal } = await import('./persistent-goals')
    const { createGoalRuntime } = await import('./goal-runtime')
    const { handleAgentChat } = await import('./chat')
    const { requestStop } = await import('./agent')
    const goal = createPersistentGoal(db, 'goal-pause-loop', '测试暂停')
    const runtime = createGoalRuntime(db, { handler: handleAgentChat, requestStop, currentAccount: () => 'test-account' })
    const run = runtime.start('goal-pause-loop', goal.id, goal.version)!
    try {
      await vi.waitFor(() => expect(providerRequests.length).toBeGreaterThan(0))
      const active = getOpenPersistentGoal(db, 'goal-pause-loop')!
      expect(runtime.pause('goal-pause-loop', goal.id, active.version)).toBe(true)
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('goal pause timed out')), 4000) })
      await Promise.race([run.completion, deadline]).finally(() => { if (timer) clearTimeout(timer) })
      expect(getOpenPersistentGoal(db, 'goal-pause-loop')?.status).toBe('paused')
      await vi.waitFor(() => expect(providerDisconnected).toBe(true))
    } finally { providerMode = 'answer'; providerRequests = [] }
  })

  it.each(['approval', 'question'] as const)('stops a goal while waiting for %s without approving it', async mode => {
    providerRequests = []
    providerMode = mode
    const sessionId = `goal-${mode}`
    const path = join(isolation.root, 'protected.txt')
    writeFileSync(path, 'do not delete')
    db.prepare('INSERT INTO sessions (id, title, workspace_dir) VALUES (?, ?, ?)').run(sessionId, 'Goal', isolation.root)
    const { createPersistentGoal, getOpenPersistentGoal, listGoalEvents } = await import('./persistent-goals')
    const { createGoalRuntime } = await import('./goal-runtime')
    const { handleAgentChat } = await import('./chat')
    const { requestStop } = await import('./agent')
    const goal = createPersistentGoal(db, sessionId, `Hello test ${mode}`)
    const runtime = createGoalRuntime(db, { handler: handleAgentChat, requestStop, currentAccount: () => 'test-account' })
    const run = runtime.start(sessionId, goal.id, goal.version)!
    try {
      await vi.waitFor(() => {
        const events = listGoalEvents(db, sessionId, goal.id, 0)
        const found = events.find(event => event.event === (mode === 'approval' ? 'tool_call' : 'question') && (mode !== 'approval' || event.payload.status === 'pending'))
        expect(found).toBeTruthy()
      })
      const { persistentGoalsRouter } = await import('../routes/persistent-goals')
      const pendingApp = new Koa().use(persistentGoalsRouter.routes())
      const supertest = (await import('supertest')).default
      const pending = await supertest(pendingApp.callback()).get(`/api/sessions/${sessionId}/goal/${goal.id}/pending`)
      expect(pending.status).toBe(200)
      expect(mode === 'approval' ? pending.body.confirmations : pending.body.questions).toHaveLength(1)
      expect(runtime.pause(sessionId, goal.id, getOpenPersistentGoal(db, sessionId)!.version)).toBe(true)
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('goal pause timed out')), 4000) })
      await Promise.race([run.completion, deadline]).finally(() => { if (timer) clearTimeout(timer) })
      expect(getOpenPersistentGoal(db, sessionId)?.status).toBe('paused')
      const afterPause = await supertest(pendingApp.callback()).get(`/api/sessions/${sessionId}/goal/${goal.id}/pending`)
      expect(afterPause.body).toEqual({ questions: [], confirmations: [] })
      expect(providerRequests).toHaveLength(1)
      expect(existsSync(path)).toBe(true)
    } finally { providerMode = 'answer'; providerRequests = [] }
  })
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
