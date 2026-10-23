/**
 * **Invariant** tests for the live reading server side.
 *
 * Why not test "is the reading correct": the audio content comes from upstream; what can break here
 * is the **state machine** —
 *   1. A turn that already wrote bytes **must not be retried** (a retry reads the same text twice;
 *      measured 8192 → 16384 bytes)
 *   2. A connection that died before any sound **must be retried** (otherwise the message loses a
 *      whole passage)
 *   3. A failure must set the `failed` flag (the client relies on it to tell "finished normally"
 *      from "stopped halfway")
 *
 * Upstream is a fake socket (EventEmitter) stand-in: all we need is exact control over "how much
 * audio is emitted, and when it breaks".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const h = vi.hoisted(() => ({ socks: [] as any[], opens: 0 }))

vi.mock('./tts', () => ({
  openUpstream: async () => {
    h.opens += 1
    const s: any = new EventEmitter()
    s.sent = []
    s.closed = false
    s.paused = false
    s.send = (b: Buffer) => s.sent.push(b)
    s.close = () => { s.closed = true }
    s.pause = () => { s.paused = true }
    s.resume = () => { s.paused = false }
    h.socks.push(s)
    return s
  },
  takeWarmConnection: () => null,
  prewarmTts: () => {},
  speechConfigFrame: () => Buffer.from('cfg'),
  ssmlFrame: () => Buffer.from('ssml'),
  TTS_OUTPUT_FORMAT: 'audio-24khz-96kbitrate-mono-mp3',
  formatForQuality: () => null,
  TTS_FIRST_CHUNK_TIMEOUT_MS: 200,
  TTS_STREAM_STALL_TIMEOUT_MS: 200,
  defaultVoice: () => 'zh-CN-XiaoxiaoNeural',
}))

import { LiveTtsSession } from './tts-session'

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const AUDIO = () => Buffer.concat([Buffer.from('Path:audio\r\n'), Buffer.alloc(8192, 1)])
const TURN_END = () => Buffer.from('Path:turn.end')

beforeEach(() => {
  h.socks = []
  h.opens = 0
})

describe('LiveTtsSession 失败语义', () => {
  it('🔴 已写过字节的轮次失败 → 不重试（重发会把同一段念两遍）', async () => {
    const s = new LiveTtsSession()
    s.push('第一段文本。')
    await tick()
    const sock = h.socks[0]
    expect(sock).toBeTruthy()
    sock.emit('message', AUDIO(), true)   // already emitted 8KB of audio
    await tick()
    sock.emit('close', 1006)              // upstream broke mid-stream
    await tick(60)
    expect(h.opens).toBe(1)               // ← no reconnect, no resend
    expect(s.sentBytes).toBe(8192)        // ← the bytes were not written twice
    expect(s.isFailed).toBe(true)         // ← this is how the client learns it stopped halfway
  })

  it('一声没出就断 → 重试一次并成功（整段内容不丢）', async () => {
    const s = new LiveTtsSession()
    s.push('第一段文本。')
    await tick()
    h.socks[0].emit('close', 1006)        // broke before any audio was sent
    await tick(350)                       // retry backoff is 200ms x (attempt+1); wait it out
    expect(h.opens).toBe(2)               // ← reconnected
    h.socks[1].emit('message', AUDIO(), true)
    h.socks[1].emit('message', TURN_END(), false)
    await tick(40)
    expect(s.sentBytes).toBe(8192)        // ← only one copy
    expect(s.isFailed).toBe(false)
  })

  it('正常路径：push → end → 队列播空后结束，failed 保持 false', async () => {
    const s = new LiveTtsSession()
    s.push('第一段文本。')
    await tick()
    h.socks[0].emit('message', AUDIO(), true)
    h.socks[0].emit('message', TURN_END(), false)
    await tick(30)
    s.end()
    await tick(30)
    expect(s.isFailed).toBe(false)
    expect(s.isEnded).toBe(true)
    expect(s.sentBytes).toBe(8192)
  })

  it('end 之后 push 被拒（返回 false，而不是静默吞掉）', async () => {
    const s = new LiveTtsSession()
    s.push('第一段文本。')
    await tick()
    h.socks[0].emit('message', AUDIO(), true)
    h.socks[0].emit('message', TURN_END(), false)
    await tick(30)
    s.end()
    expect(s.push('这段不该被收下')).toBe(false)
  })
})
