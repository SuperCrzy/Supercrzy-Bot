import { describe, expect, it, vi } from 'vitest'
import { makeGoalAgentRunner } from './goal-agent-adapter'
import type { PersistentGoal } from './persistent-goals'

const goal: PersistentGoal = { id: 'g', session_id: 's', objective: 'goal', acceptance: '', status: 'paused', elapsed_ms: 0, current_run_id: null, last_result: '', version: 1, created_at: 0, updated_at: 0 }
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

describe('goal agent adapter', () => {
  it('requests stop on account change during a silent run and stays interrupted if the account switches back', async () => {
    let current = true, notify!: () => void, finish!: () => void
    const stop = vi.fn(), unsubscribe = vi.fn()
    const runner = makeGoalAgentRunner({ ownerIsCurrent: () => current, requestStop: stop, makeMessages: async () => [], onAccountChange: listener => { notify = listener; return unsubscribe }, handler: async ctx => {
      ctx.res.write(frame('config', {}))
      await new Promise<void>(resolve => { finish = resolve })
      ctx.res.write(frame('done', { finished: true }))
    } })
    const result = runner({ goal, runId: 'r', signal: new AbortController().signal, emit: vi.fn() })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    notify() // token refresh for the same account
    expect(stop).not.toHaveBeenCalled()
    current = false; notify()
    expect(stop).toHaveBeenCalledWith('s')
    current = true; notify(); finish()
    expect((await result).outcome).toBe('interrupted')
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it('interrupts if the account changes after the final event and before the handler returns', async () => {
    let current = true
    const runner = makeGoalAgentRunner({ ownerIsCurrent: () => current, requestStop: vi.fn(), makeMessages: async () => [], handler: async ctx => {
      ctx.res.write(frame('content', { content: '旧账号的结果' }))
      ctx.res.write(frame('done', { finished: true }))
      current = false
    } })
    const result = await runner({ goal, runId: 'r', signal: new AbortController().signal, emit: vi.fn() })
    expect(result.outcome).toBe('interrupted')
    expect(result.summary).not.toContain('旧账号的结果')
    expect(result.progressFingerprint).toBeUndefined()
  })
  it('rejects structured failures as progress even when their text looks successful', async () => {
    const runner = makeGoalAgentRunner({ ownerIsCurrent: () => true, requestStop: vi.fn(), makeMessages: async () => [], handler: async ctx => {
      ctx.res.write(frame('tool_call', { id: 't1', name: 'file_read', arguments: '{}' }))
      ctx.res.write(frame('tool_result', { tool_call_id: 't1', content: 'looks successful', status: 'error' }))
      ctx.res.write(frame('content', { content: '尝试读取。\n<goal_report>{"action":"continue","evidence_call_ids":["t1"]}</goal_report>' }))
      ctx.res.write(frame('done', { finished: true }))
    } })
    const result = await runner({ goal, runId: 'r', signal: new AbortController().signal, emit: vi.fn() })
    expect(result.progressFingerprint).toBeUndefined()
  })
  it('reassembles fragmented and combined SSE events without losing the answer', async () => {
    const emit = vi.fn()
    const runner = makeGoalAgentRunner({ ownerIsCurrent: () => true, requestStop: vi.fn(), makeMessages: async () => [], handler: async ctx => {
      const all = frame('config', {}) + frame('content', { content: '完整结果' }) + frame('done', { finished: true })
      for (let i = 0; i < all.length; i += 7) ctx.res.write(all.slice(i, i + 7))
    } })
    expect(await runner({ goal, runId: 'r', signal: new AbortController().signal, emit })).toEqual({ outcome: 'paused', summary: '完整结果' })
    expect(emit).toHaveBeenCalledWith('content', { content: '完整结果' })
  })
  it('treats an incomplete trailing event as an interruption even after done', async () => {
    const runner = makeGoalAgentRunner({ ownerIsCurrent: () => true, requestStop: vi.fn(), makeMessages: async () => [], handler: async ctx => {
      ctx.res.write(frame('done', { finished: true }) + 'event: question\ndata: {')
    } })
    expect((await runner({ goal, runId: 'r', signal: new AbortController().signal, emit: vi.fn() })).outcome).toBe('interrupted')
  })
  it('allows continuation only when the report references an observed successful tool result', async () => {
    const runner = makeGoalAgentRunner({ ownerIsCurrent: () => true, requestStop: vi.fn(), makeMessages: async () => [], handler: async ctx => {
      ctx.res.write(frame('config', {}))
      ctx.res.write(frame('tool_call', { id: 't1', name: 'file_read', arguments: '{"path":"a"}' }))
      ctx.res.write(frame('tool_result', { tool_call_id: 't1', content: 'found content' }))
      ctx.res.write(frame('content', { content: '已检查。\n<goal_report>{"action":"continue","evidence_call_ids":["t1"]}</goal_report>' }))
      ctx.res.write(frame('done', { finished: true }))
    } })
    const result = await runner({ goal, runId: 'r', signal: new AbortController().signal, emit: vi.fn() })
    expect(result.summary).toBe('已检查。')
    expect(result.progressFingerprint).toMatch(/^[a-f0-9]{64}$/)
  })
  it('forwards events but does not claim the overall goal is complete', async () => {
    const emit = vi.fn()
    const runner = makeGoalAgentRunner({ ownerIsCurrent: () => true, requestStop: vi.fn(), makeMessages: async () => [{ role: 'user', content: 'goal' }], handler: async ctx => {
      ctx.res.write(frame('config', {})); ctx.res.write(frame('content', { content: '本轮结果' })); ctx.res.write(frame('done', { finished: true }))
    } })
    expect(await runner({ goal, runId: 'r', signal: new AbortController().signal, emit })).toEqual({ outcome: 'paused', summary: '本轮结果' })
    expect(emit).toHaveBeenCalledWith('content', { content: '本轮结果' })
  })
  it('signals stop and waits for the handler to exit', async () => {
    const controller = new AbortController(), stop = vi.fn()
    let finish!: () => void
    const runner = makeGoalAgentRunner({ ownerIsCurrent: () => true, requestStop: stop, makeMessages: async () => [], handler: async ctx => {
      ctx.res.write(frame('config', {}))
      await new Promise<void>(resolve => { finish = resolve })
      ctx.res.write(frame('task_state', { status: 'cancelled' })); ctx.res.write(frame('done', { finished: true }))
    } })
    const result = runner({ goal, runId: 'r', signal: controller.signal, emit: vi.fn() })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    controller.abort()
    expect(stop).toHaveBeenCalledWith('s')
    finish()
    expect((await result).outcome).toBe('paused')
  })
  it('distinguishes a confirmed pause with unfinished work from a missing terminal event', async () => {
    const controller = new AbortController()
    const runner = makeGoalAgentRunner({ ownerIsCurrent: () => true, requestStop: vi.fn(), makeMessages: async () => [], handler: async ctx => {
      ctx.res.write(frame('config', {}))
      controller.abort()
      ctx.res.write(frame('checkpoint_available', {}))
      ctx.res.write(frame('task_state', { status: 'paused' }))
      ctx.res.write(frame('done', { finished: false }))
    } })
    expect((await runner({ goal, runId: 'r', signal: controller.signal, emit: vi.fn() })).outcome).toBe('paused')
  })
  it('does not overwrite an interruption marker with a later completed status', async () => {
    const runner = makeGoalAgentRunner({ ownerIsCurrent: () => true, requestStop: vi.fn(), makeMessages: async () => [], handler: async ctx => {
      ctx.res.write(frame('checkpoint_available', {}))
      ctx.res.write(frame('task_state', { status: 'completed' }))
      ctx.res.write(frame('done', { finished: true }))
    } })
    expect((await runner({ goal, runId: 'r', signal: new AbortController().signal, emit: vi.fn() })).outcome).toBe('interrupted')
  })
  it('treats missing terminal event and event persistence failure as interruption', async () => {
    const stop = vi.fn()
    const runner = makeGoalAgentRunner({ ownerIsCurrent: () => true, requestStop: stop, makeMessages: async () => [], handler: async ctx => {
      ctx.res.write(frame('config', {})); ctx.res.write(frame('content', { content: 'partial' }))
    } })
    expect((await runner({ goal, runId: 'r', signal: new AbortController().signal, emit: vi.fn() })).outcome).toBe('interrupted')
    expect((await runner({ goal, runId: 'r', signal: new AbortController().signal, emit: () => { throw new Error('db full') } })).outcome).toBe('interrupted')
    expect(stop).toHaveBeenCalledWith('s')
  })
})
