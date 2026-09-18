/**
 * 事件循环延迟采样单测（2026-09-18）
 *
 * 这个模块的产出一旦失真，就会把"后端真卡"和"前端/传输层问题"判反——
 * 08-27 那次反复推翻的排查就是缺这个判据导致的。所以判读阈值必须被测试锁死。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  getEventLoopStats,
  resetEventLoopStats,
  __pushBucketForTest,
} from './event-loop-lag'

beforeEach(() => resetEventLoopStats())

/** 造一个滚窗桶（t 固定，只关心 max/mean/samples） */
const bucket = (max: number, mean = 1, samples = 50) => ({ t: Date.now(), max, mean, samples })

describe('未启动采样时', () => {
  it('返回 available=false 且 verdict 保守为 ok（不误报卡顿）', () => {
    const s = getEventLoopStats()
    expect(s.available).toBe(false)
    expect(s.verdict).toBe('ok')
    expect(s.max_60s_ms).toBe(0)
    expect(s.series).toEqual([])
  })
})

describe('判读阈值（verdict）', () => {
  it('60 秒最大延迟 <100ms → ok', () => {
    __pushBucketForTest(bucket(12))
    __pushBucketForTest(bucket(88))
    const s = getEventLoopStats()
    expect(s.verdict).toBe('ok')
    expect(s.max_60s_ms).toBe(88)
  })

  it('100~1000ms → busy（有同步阻塞调用，但没冻死）', () => {
    __pushBucketForTest(bucket(340))
    expect(getEventLoopStats().verdict).toBe('busy')
  })

  it('>1000ms → blocked（同步调用冻住事件循环，并发 SSE 会整体停推）', () => {
    __pushBucketForTest(bucket(8000))
    expect(getEventLoopStats().verdict).toBe('blocked')
  })

  it('阈值边界：正好 100 / 正好 1000 都归入较严重的一侧', () => {
    __pushBucketForTest(bucket(100))
    expect(getEventLoopStats().verdict).toBe('busy')
    resetEventLoopStats()
    __pushBucketForTest(bucket(1000))
    expect(getEventLoopStats().verdict).toBe('blocked')
  })
})

describe('滚窗（10 秒 / 60 秒）', () => {
  it('10 秒窗口只看最近 10 个桶——久远的尖峰不算"刚才卡过"', () => {
    __pushBucketForTest(bucket(5000)) // 旧尖峰
    for (let i = 0; i < 10; i++) __pushBucketForTest(bucket(5))
    const s = getEventLoopStats()
    expect(s.max_10s_ms).toBe(5)
    expect(s.max_60s_ms).toBe(5000) // 60 秒窗口仍能看见
  })

  it('超过 60 个桶后丢弃最旧的', () => {
    __pushBucketForTest(bucket(9000)) // 第 1 个，应被挤出
    for (let i = 0; i < 60; i++) __pushBucketForTest(bucket(3))
    const s = getEventLoopStats()
    expect(s.max_60s_ms).toBe(3)
    expect(s.series.length).toBe(60)
  })

  it('mean 按采样数加权，不被空闲秒拉低', () => {
    __pushBucketForTest(bucket(10, 10, 100)) // 100 个采样，均值 10
    __pushBucketForTest(bucket(10, 0, 1))    // 1 个采样，均值 0
    const s = getEventLoopStats()
    expect(s.mean_60s_ms).toBeCloseTo(9.9, 1)
    expect(s.samples_60s).toBe(101)
  })

  it('series 按旧→新排列，供前端画曲线', () => {
    __pushBucketForTest(bucket(1))
    __pushBucketForTest(bucket(2))
    __pushBucketForTest(bucket(3))
    expect(getEventLoopStats().series).toEqual([1, 2, 3])
  })
})

describe('resetEventLoopStats', () => {
  it('清空滚窗，避免压测读数被历史数据污染', () => {
    __pushBucketForTest(bucket(9000))
    expect(getEventLoopStats().max_60s_ms).toBe(9000)
    resetEventLoopStats()
    const s = getEventLoopStats()
    expect(s.max_60s_ms).toBe(0)
    expect(s.series).toEqual([])
    expect(s.verdict).toBe('ok')
  })
})
