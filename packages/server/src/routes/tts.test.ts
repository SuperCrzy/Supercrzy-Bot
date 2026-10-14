import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { waitWritable } from './tts'

/**
 * 反压等待的两个出口。
 *
 * 为什么值得单独测：这条 Promise 是**上游 socket 的开关**。
 * `services/tts.ts` 见到 thenable 就 `socket.pause()`，等它 settle 才 `resume()`。
 * 如果它永远不 settle，上游 ws 会**永久挂着**（既不读完也不关闭），
 * 而请求本身早结束了、日志里毫无痕迹 —— 典型的"慢速泄漏"。
 *
 * 🔴 关键的一条是 `close`：`ctx.res` 的 close 分支会 `out.destroy()`，
 *    此后 `drain` 永远不会再来（缓冲没了，谁来 drain）。只等 drain 的实现会永久挂住。
 */
describe('waitWritable：反压等待', () => {
  it('drain 到来时 resolve', async () => {
    const s = new PassThrough()
    let done = false
    const p = waitWritable(s).then(() => { done = true })
    expect(done).toBe(false)
    s.emit('drain')
    await p
    expect(done).toBe(true)
  })

  it('🔴 下游被 destroy（用户点了停止）也必须 resolve —— 只等 drain 会永久挂住', async () => {
    const s = new PassThrough()
    let done = false
    const p = waitWritable(s).then(() => { done = true })
    s.destroy()
    await p
    expect(done).toBe(true)
  })

  it('resolve 之后要摘掉监听器（否则每次反压都在 PassThrough 上堆一个 once）', async () => {
    const s = new PassThrough()
    const p = waitWritable(s)
    s.emit('drain')
    await p
    expect(s.listenerCount('drain')).toBe(0)
    expect(s.listenerCount('close')).toBe(0)
  })

  it('drain 与 close 先后到达也只 resolve 一次', async () => {
    const s = new PassThrough()
    let n = 0
    await new Promise<void>((r) => {
      waitWritable(s).then(() => { n += 1 })
      s.emit('drain')
      s.emit('close')
      setImmediate(r)
    })
    expect(n).toBe(1)
  })
})
