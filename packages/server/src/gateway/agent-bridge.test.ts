/**
 * Tests for the shared channel→agent bridge.
 *
 * These assert the *invariants that were broken*, not just happy-path output:
 *
 *   1. A frame split across two TCP chunks must not be lost or mangled.
 *      (The old per-channel loop parsed the partial tail then dropped it.)
 *   2. `event: content_chunk` must be accumulated — the real server event name.
 *      (The old code looked for `type: 'block'` which the server never emits.)
 *   3. Only the answer is returned: narration events (`thinking_chunk`) must not leak in.
 *   4. A real `error` event surfaces as an error; `stopped`/`paused` must not.
 */
import { describe, it, expect } from 'vitest'
import { SseFrameParser, applyFrame, callAgent, type SseFrame } from './agent-bridge'

/** Build an SSE body string exactly the way `agent.ts`'s emitSSE does. */
function sse(event: string, data: unknown, id = 1): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/** A Response whose body yields the given chunks with the exact boundaries provided. */
function streamingResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[i++]))
    },
  })
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } })
}

describe('SseFrameParser', () => {
  it('does not emit a frame until the blank-line terminator arrives', () => {
    const p = new SseFrameParser()
    // A complete "event:" line but no terminating blank line yet.
    expect(p.push('event: content_chunk\ndata: {"text":"hi"}')).toEqual([])
    expect(p.push('\n\n')).toEqual([{ event: 'content_chunk', data: '{"text":"hi"}' }])
  })

  it('reassembles a JSON payload split mid-token across chunks', () => {
    const p = new SseFrameParser()
    const full = sse('content_chunk', { text: '跨' + 'chunk' })
    // Cut in the middle of the JSON string — the case the old code corrupted.
    const cut = full.indexOf('"text"') + 8
    const frames = [...p.push(full.slice(0, cut)), ...p.push(full.slice(cut))]
    expect(frames).toHaveLength(1)
    expect(JSON.parse(frames[0].data).text).toBe('跨chunk')
  })

  it('ignores id lines and comment heartbeats', () => {
    const p = new SseFrameParser()
    const frames = p.push(': connected\n\n' + sse('content_chunk', { text: 'a' }))
    expect(frames).toEqual([{ event: 'content_chunk', data: '{"text":"a"}' }])
  })

  it('tolerates CRLF line endings', () => {
    const p = new SseFrameParser()
    const frames = p.push('event: content_chunk\r\ndata: {"text":"x"}\r\n\r\n')
    expect(frames).toEqual([{ event: 'content_chunk', data: '{"text":"x"}' }])
  })

  it('flush() rescues a trailing frame with no final blank line', () => {
    const p = new SseFrameParser()
    p.push('event: content_chunk\ndata: {"text":"tail"}')
    expect(p.flush()).toEqual([{ event: 'content_chunk', data: '{"text":"tail"}' }])
  })
})

describe('applyFrame', () => {
  const empty = () => ({ text: '', error: null as string | null })

  it('accumulates content_chunk deltas in order', () => {
    const acc = empty()
    applyFrame({ event: 'content_chunk', data: '{"text":"你"}' }, acc)
    applyFrame({ event: 'content_chunk', data: '{"text":"好"}' }, acc)
    expect(acc.text).toBe('你好')
  })

  it('never lets narration (thinking_chunk) into the answer', () => {
    const acc = empty()
    applyFrame({ event: 'thinking_chunk', data: '{"text":"我在思考…"}' }, acc)
    applyFrame({ event: 'content_chunk', data: '{"text":"答案是 42"}' }, acc)
    expect(acc.text).toBe('答案是 42')
  })

  it('treats stopped/paused as not-an-error', () => {
    const acc = empty()
    applyFrame({ event: 'error', data: '{"message":"已收到停止指令","stopped":true}' }, acc)
    expect(acc.error).toBeNull()
  })

  it('surfaces a genuine error event', () => {
    const acc = empty()
    applyFrame({ event: 'error', data: '{"message":"context overflow"}' }, acc)
    expect(acc.error).toBe('context overflow')
  })

  it('flags an unfinished run reported by done', () => {
    const acc = empty()
    applyFrame({ event: 'done', data: '{"finished":false}' }, acc)
    expect(acc.error).toContain('未完成')
  })

  it('ignores a truncated JSON payload instead of throwing', () => {
    const acc = empty()
    const frame: SseFrame = { event: 'content_chunk', data: '{"text":"trunc' }
    expect(() => applyFrame(frame, acc)).not.toThrow()
    expect(acc.text).toBe('')
  })
})

describe('callAgent', () => {
  it('returns the accumulated answer from a chunked stream', async () => {
    const body = [
      sse('config', { model: 'x' }, 1),
      sse('thinking_chunk', { text: '思考中' }, 2),
      sse('content_chunk', { text: '第一句。' }, 3),
      sse('content_chunk', { text: '第二句。' }, 4),
      sse('done', { finished: true }, 5),
    ].join('')

    // Split into 7-byte pieces to force frame boundaries mid-JSON.
    const chunks: string[] = []
    for (let i = 0; i < body.length; i += 7) chunks.push(body.slice(i, i + 7))

    const orig = globalThis.fetch
    globalThis.fetch = (async () => streamingResponse(chunks)) as any
    try {
      const reply = await callAgent({ userText: 'hi' })
      expect(reply.text).toBe('第一句。第二句。')
      expect(reply.error).toBeNull()
    } finally {
      globalThis.fetch = orig
    }
  })

  it('reports an HTTP failure instead of a generic apology', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as any
    try {
      const reply = await callAgent({ userText: 'hi' })
      expect(reply.error).toContain('500')
    } finally {
      globalThis.fetch = orig
    }
  })

  it('survives a network throw', async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as any
    try {
      const reply = await callAgent({ userText: 'hi' })
      expect(reply.error).toContain('ECONNREFUSED')
    } finally {
      globalThis.fetch = orig
    }
  })
})
