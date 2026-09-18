/**
 * SSE 流健康单测（2026-09-18）
 *
 * 锁死三件不能退化的事：
 *   1. 断连后写入必须被丢弃，且**不能抛**——裸 res.write 在 Koa ctx.respond=false 下
 *      抛出的 ERR_STREAM_WRITE_AFTER_END 会变成未捕获异常，直接带走整个后端进程。
 *   2. 活跃流计数三条释放路径（close / finish / error）都要生效，否则指标只增不减。
 *   3. 背压（write 返回 false）必须被计数——"前端不推进"要先能看见这个数字。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import {
  registerSseStream,
  safeWriteSse,
  endSseStream,
  getSseStats,
  resetSseStats,
  __clearStreamsForTest,
} from './sse-health'

/** 最小可用的假响应：够 safeWriteSse 判断可写性 + 能触发 close/finish/error */
function fakeRes(opts: { writeOk?: boolean } = {}) {
  const res: any = new EventEmitter()
  res.writableEnded = false
  res.writableFinished = false
  res.destroyed = false
  res.chunks = [] as string[]
  res.write = (chunk: string) => {
    res.chunks.push(chunk)
    return opts.writeOk !== false
  }
  res.end = () => { res.writableEnded = true; res.emit('finish') }
  return res
}
const ctxOf = (res: any) => ({ res }) as any

beforeEach(() => __clearStreamsForTest())

describe('safeWriteSse：可写性判断', () => {
  it('正常响应写入成功，并累计到流记录', () => {
    const res = fakeRes()
    registerSseStream(ctxOf(res), 'agent')
    expect(safeWriteSse(ctxOf(res), 'data: 1\n\n')).toBe(true)
    const s = getSseStats()
    expect(s.active).toBe(1)
    expect(s.writes).toBe(1)
    expect(s.streams[0].label).toBe('agent')
    expect(s.streams[0].writes).toBe(1)
  })

  it('writableEnded 后写入被丢弃，不落盘也不抛', () => {
    const res = fakeRes()
    registerSseStream(ctxOf(res), 'agent')
    res.writableEnded = true
    expect(safeWriteSse(ctxOf(res), 'data: 1\n\n')).toBe(false)
    expect(res.chunks).toEqual([])
    expect(getSseStats().dropped).toBe(1)
  })

  it('destroyed 后写入被丢弃（断网场景）', () => {
    const res = fakeRes()
    registerSseStream(ctxOf(res), 'agent')
    res.destroyed = true
    expect(safeWriteSse(ctxOf(res), 'data: 1\n\n')).toBe(false)
    expect(getSseStats().dropped).toBe(1)
  })

  it('write 抛错时被吃掉并计入丢弃——这正是裸 write 会带走进程的路径', () => {
    const res = fakeRes()
    registerSseStream(ctxOf(res), 'agent')
    res.write = () => { throw new Error('ERR_STREAM_WRITE_AFTER_END') }
    expect(() => safeWriteSse(ctxOf(res), 'x')).not.toThrow()
    expect(safeWriteSse(ctxOf(res), 'x')).toBe(false)
    expect(getSseStats().dropped).toBe(2)
  })

  it('无 res 的脏 ctx 不抛错', () => {
    expect(safeWriteSse({} as any, 'x')).toBe(false)
    expect(safeWriteSse(undefined as any, 'x')).toBe(false)
  })
})

describe('safeWriteSse：背压计数', () => {
  it('write 返回 false → backpressured 递增（客户端消费跟不上）', () => {
    const res = fakeRes({ writeOk: false })
    registerSseStream(ctxOf(res), 'chat-stream')
    expect(safeWriteSse(ctxOf(res), 'data: 1\n\n')).toBe(true) // 仍算写入成功，只是有背压
    const s = getSseStats()
    expect(s.backpressured).toBe(1)
    expect(s.streams[0].backpressured).toBe(1)
  })

  it('未注册的响应也能写（不因漏注册而丢输出），只是不计入明细', () => {
    const res = fakeRes()
    expect(safeWriteSse(ctxOf(res), 'data: 1\n\n')).toBe(true)
    expect(getSseStats().active).toBe(0)
    expect(getSseStats().writes).toBe(1)
  })
})

describe('活跃流计数：三条释放路径都必须生效', () => {
  it('close 释放', () => {
    const res = fakeRes()
    registerSseStream(ctxOf(res), 'agent')
    expect(getSseStats().active).toBe(1)
    res.emit('close')
    expect(getSseStats().active).toBe(0)
  })

  it('finish 释放（正常写完）', () => {
    const res = fakeRes()
    registerSseStream(ctxOf(res), 'agent')
    endSseStream(ctxOf(res))
    expect(getSseStats().active).toBe(0)
  })

  it('error 释放（写失败/EPIPE），且不会因重复释放把计数打成负数', () => {
    const res = fakeRes()
    registerSseStream(ctxOf(res), 'agent')
    res.emit('error', new Error('EPIPE'))
    res.emit('close')
    res.emit('finish')
    expect(getSseStats().active).toBe(0)
  })

  it('同一 res 重复注册只算一条（幂等）', () => {
    const res = fakeRes()
    registerSseStream(ctxOf(res), 'agent')
    registerSseStream(ctxOf(res), 'agent-again')
    expect(getSseStats().active).toBe(1)
    expect(getSseStats().streams[0].label).toBe('agent')
  })

  it('多条并发流分别计数（多会话/多窗口场景）', () => {
    const a = fakeRes(); const b = fakeRes(); const c = fakeRes()
    registerSseStream(ctxOf(a), 'agent')
    registerSseStream(ctxOf(b), 'agent')
    registerSseStream(ctxOf(c), 'compare-stream')
    expect(getSseStats().active).toBe(3)
    a.emit('close')
    expect(getSseStats().active).toBe(2)
    expect(getSseStats().streams.map((s) => s.label).sort()).toEqual(['agent', 'compare-stream'])
  })
})

describe('endSseStream：幂等且带计数释放', () => {
  it('重复调用不抛，且释放后写入被丢弃', () => {
    const res = fakeRes()
    registerSseStream(ctxOf(res), 'agent')
    endSseStream(ctxOf(res))
    expect(() => endSseStream(ctxOf(res))).not.toThrow()
    expect(safeWriteSse(ctxOf(res), 'x')).toBe(false)
  })

  it('对没有 end 的对象不抛', () => {
    expect(() => endSseStream({ res: {} } as any)).not.toThrow()
  })
})

describe('resetSseStats', () => {
  it('清零累计值但不影响活跃流明细', () => {
    const res = fakeRes()
    registerSseStream(ctxOf(res), 'agent')
    safeWriteSse(ctxOf(res), 'x')
    resetSseStats()
    const s = getSseStats()
    expect(s.writes).toBe(0)
    expect(s.dropped).toBe(0)
    expect(s.backpressured).toBe(0)
    expect(s.active).toBe(1)
  })
})
