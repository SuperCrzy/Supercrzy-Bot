import { describe, expect, it, vi } from 'vitest'
import { makeGoalAgentRunner } from './goal-agent-adapter'
import type { PersistentGoal } from './persistent-goals'

const goal: PersistentGoal = { id: 'g', session_id: 's', objective: 'goal', acceptance: '', status: 'paused', elapsed_ms: 0, current_run_id: null, last_result: '', version: 1, created_at: 0, updated_at: 0 }
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

describe('goal agent adapter', () => {
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
