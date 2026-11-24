import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../config', () => ({ config: { db: { path: ':memory:' }, deepseek: { apiKey: '', baseUrl: 'https://example.invalid', defaultModel: 'deepseek-chat' }, workspaceDir: '' } }))
vi.mock('./agent', () => ({ runAgentLoop: state.run }))
vi.mock('./ai-browser', () => ({ closeBrowserForSession: vi.fn() }))
import { initDatabase, getDB } from './database'
import { handleAgentChat } from './chat'
import { createGoalRuntime } from './goal-runtime'
import { createPersistentGoal, getOpenPersistentGoal, listGoalEvents } from './persistent-goals'
import { acquireAgentSession } from './agent-session-lock'
import { EventEmitter } from 'node:events'

beforeEach(() => {
  process.env.DB_PATH = ':memory:'
  initDatabase()
  getDB().prepare("INSERT INTO sessions (id, title) VALUES ('session', 'test')").run()
})
afterEach(() => { getDB().close(); delete process.env.DB_PATH; vi.resetAllMocks() })

describe('goal runtime through chat handler', () => {
  it('includes only the current session goal in ordinary agent follow-ups', async () => {
    const db = getDB(), goal = createPersistentGoal(db, 'session', '修复桌面体验', '测试通过')
    const { claimGoalRun, settleGoalRun } = await import('./persistent-goals')
    const run = claimGoalRun(db, 'session', goal.id, goal.version)!
    settleGoalRun(db, goal.id, run, 'paused', '已修复按钮')
    const res = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), writableEnded: false })
    state.run.mockImplementation(async () => {})
    const ctx: any = { state: {}, request: { body: { sessionId: 'session', messages: [{ role: 'user', content: '进展如何？' }] } }, req: new EventEmitter(), res, set: vi.fn() }
    await handleAgentChat(ctx)
    const messages = state.run.mock.calls[0][1]
    expect(messages.at(-1).content).toBe('进展如何？')
    expect(messages[0].content).toContain('修复桌面体验')
    expect(messages[0].content).toContain('已修复按钮')
    expect(ctx.request.body.messages).toHaveLength(2)
  })
  it('passes through the regular handler, records events, and releases the session lock', async () => {
    const db = getDB(), goal = createPersistentGoal(db, 'session', '完成项目')
    state.run.mockImplementation(async (ctx: any) => {
      ctx.res.write('event: config\ndata: {}\n\n')
      ctx.res.write('event: content\ndata: {"content":"进度"}\n\n')
      ctx.res.write('event: task_state\ndata: {"status":"completed"}\n\n')
      ctx.res.write('event: done\ndata: {"finished":true}\n\n')
    })
    const runtime = createGoalRuntime(db, { handler: handleAgentChat, requestStop: vi.fn(), currentAccount: () => 'owner' })
    await runtime.start('session', goal.id, goal.version)!.completion
    expect(state.run).toHaveBeenCalledOnce()
    expect(getOpenPersistentGoal(db, 'session')).toMatchObject({ status: 'paused', last_result: '进度' })
    expect(listGoalEvents(db, 'session', goal.id, 0).map(event => event.event)).toContain('content')
    const release = acquireAgentSession(db, 'session')
    expect(release).toBeTypeOf('function')
    release!()
  })

  it('does not invoke the model when the session is already busy', async () => {
    const db = getDB(), goal = createPersistentGoal(db, 'session', '完成项目')
    const release = acquireAgentSession(db, 'session')!
    const runtime = createGoalRuntime(db, { handler: handleAgentChat, requestStop: vi.fn(), currentAccount: () => 'owner' })
    await runtime.start('session', goal.id, goal.version)!.completion
    expect(state.run).not.toHaveBeenCalled()
    expect(getOpenPersistentGoal(db, 'session')?.status).toBe('interrupted')
    release()
  })
})
