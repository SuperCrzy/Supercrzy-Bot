import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ inserts: [] as Array<unknown[]> }))
vi.mock('./database', () => ({ getDB: () => ({ prepare: (sql: string) => ({
  get: () => sql.includes('sessions') ? { id: 'exists' } : undefined,
  all: () => [{ role: 'user', content: 'hello' }],
  run: (...args: unknown[]) => { state.inserts.push(args) },
}) }) }))
vi.mock('./tunnel', () => ({ createPreviewLink: () => 'https://example.invalid/preview' }))
import { QQBotRunner } from './qqbot-runner'

beforeEach(() => { state.inserts.length = 0 })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('QQ Agent stream', () => {
  it('sends a session ID and returns streamed content after completion', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ sessionId: expect.stringMatching(/^qq-/) })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response('event: content_chunk\ndata: {"text":"hello back"}\n\nevent: done\ndata: {"finished":true}\n\n')
    }))
    const runner = new QQBotRunner({ appId: 'bot', appSecret: 'secret', intents: 0, agentPort: 3000 })
    expect(await (runner as any).callAgent('user', 'hello', 'conversation')).toBe('hello back')
    expect(state.inserts.at(-1)?.at(-1)).toBe('hello back')
  })
  it('marks a disconnected stream incomplete and keeps its partial answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('event: content_chunk\ndata: {"text":"partial"}\n\n')))
    const runner = new QQBotRunner({ appId: 'bot', appSecret: 'secret', intents: 0, agentPort: 3000 })
    const reply = await (runner as any).callAgent('user', 'hello', 'conversation')
    expect(reply).toContain('partial')
    expect(reply).toContain('任务未确认完成')
    expect(state.inserts.at(-1)?.at(-1)).toBe(reply)
  })
})
