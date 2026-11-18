import { describe, expect, it, vi } from 'vitest'
import { readWechatAgentStream } from './wechat-agent-stream'

describe('WeChat Agent stream', () => {
  it('returns the final text and records completion across split SSE chunks', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(encoder.encode('event: content_chunk\ndata: {"text":"partial"}\n\nevent: cont'))
      c.enqueue(encoder.encode('ent\ndata: {"content":"final"}\n\nevent: task_state\ndata: {"status":"completed"}\n\nevent: done\ndata: {"finished":true}\n\n'))
      c.close()
    } })
    expect(await readWechatAgentStream(stream, new AbortController())).toEqual({ text: 'final', filePath: '', completed: true })
  })
  it('reports EOF without a done event as incomplete', async () => {
    const stream = new Response('event: content_chunk\ndata: {"text":"partial"}\n\n').body!
    expect(await readWechatAgentStream(stream, new AbortController())).toMatchObject({ text: 'partial', completed: false })
  })
  it('does not claim success when cancelled even if a done event follows', async () => {
    const stream = new Response('event: task_state\ndata: {"status":"cancelled"}\n\nevent: done\ndata: {"finished":true}\n\n').body!
    expect((await readWechatAgentStream(stream, new AbortController())).completed).toBe(false)
  })
  it('aborts and cancels a stream that remains idle', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ cancel })
    const controller = new AbortController()
    await expect(readWechatAgentStream(stream, controller, { idleMs: 10 })).rejects.toThrow('agent_stream_idle_timeout')
    expect(controller.signal.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
  })
})
