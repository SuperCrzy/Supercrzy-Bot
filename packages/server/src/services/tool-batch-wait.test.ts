import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForToolBatch } from './tool-batch-wait'
import { executeToolCalls } from './tools'

afterEach(() => vi.useRealTimers())

describe('tool batch waiting', () => {
  it('warns when slow but waits for the actual result before continuing', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    const run = new Promise<string>((resolve) => { finish = resolve })
    const warn = vi.fn()
    const finished = vi.fn()
    const pending = waitForToolBatch(run, 1000, warn).then(finished)
    await vi.advanceTimersByTimeAsync(1000)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(finished).not.toHaveBeenCalled()
    finish('real result')
    await pending
    expect(finished).toHaveBeenCalledWith('real result')
  })

  it('clears the warning timer after fast completion or failure', async () => {
    vi.useFakeTimers()
    const warn = vi.fn()
    expect(await waitForToolBatch(Promise.resolve('ok'), 1000, warn)).toBe('ok')
    await expect(waitForToolBatch(Promise.reject(new Error('failed')), 1000, warn)).rejects.toThrow('failed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not start queued tool calls after a stop request', async () => {
    const result = await executeToolCalls([{ id: 'call-1', type: 'function', function: { name: 'file_write', arguments: '{}' } }], { shouldStop: () => true })
    expect(result).toMatchObject([{ tool_call_id: 'call-1', skipped: true, content: '已请求停止，该工具未执行。' }])
  })
  it('marks dispatcher failures structurally without claiming a tool ran', async () => {
    const results = await executeToolCalls([
      { id: 'missing', type: 'function', function: { name: 'not_a_tool', arguments: '{}' } },
      { id: 'bad-args', type: 'function', function: { name: 'file_read', arguments: '{' } },
    ])
    expect(results).toMatchObject([{ tool_call_id: 'missing', dispatchError: true }, { tool_call_id: 'bad-args', dispatchError: true }])
  })
})
