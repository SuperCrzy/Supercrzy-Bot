/**
 * A1 不变量（2026-10-22）：错误提示绝不能顶掉本轮答案。
 *
 * 断言写成"bug 存在时结果会不会变"：
 *   - 有正文时若把 hint 写进 content → 第 1 条必然失败（`content` 应为 undefined）；
 *   - 无正文时若不写 ❌ → 第 3 条失败；
 *   - hint 缺失时若不回退 message → 第 4 条失败。
 */
import { describe, it, expect } from 'vitest'
import { applyAgentStreamError, hasAgentAnswer, resolveErrorDisplay } from './api-error-display'
import { createChatStream } from '@/stores/chat-stream'
import type { ChatMessage } from '@/types'

it('flushes a real typewriter buffer before attaching a terminal error', async () => {
  const msg = { role: 'assistant', content: '部分回答', flow: [] } as unknown as ChatMessage
  const stream = createChatStream(msg)
  stream.pushText('部分回答')
  expect(msg.flow).toEqual([])
  applyAgentStreamError(msg, stream, { message: '模型连接失败' }, '任务中断')
  await stream.finish()
  expect(msg.content).toBe('部分回答')
  expect(msg.flow).toEqual([expect.objectContaining({ kind: 'text', text: '部分回答' })])
  expect(msg.stopReason?.message).toBe('模型连接失败')
})

it('preserves received text even before the typewriter has rendered a flow node', () => {
  const hadText = hasAgentAnswer('已收到的部分答案', '')
  expect(hadText).toBe(true)
  expect(resolveErrorDisplay({ hadText, message: '连接失败' })).toEqual({ stopReason: { reason: 'error', message: '连接失败' } })
  expect(hasAgentAnswer('', '已渲染')).toBe(true)
  expect(hasAgentAnswer('  ', '')).toBe(false)
})

describe('resolveErrorDisplay', () => {
  it('有正文：只挂横幅，不许碰 content', () => {
    const d = resolveErrorDisplay({
      hadText: true,
      hint: '**账户余额不足**\n\n请充值',
      message: '[billing] 402',
      reason: 'billing',
    })
    expect(d.content).toBeUndefined()
    expect(d.stopReason).toEqual({ reason: 'billing', message: '**账户余额不足**\n\n请充值' })
  })

  it('有正文但 hint 缺失：横幅回退后端 message', () => {
    const d = resolveErrorDisplay({ hadText: true, message: '[connection] fetch failed', reason: 'connection' })
    expect(d.content).toBeUndefined()
    expect(d.stopReason?.message).toBe('[connection] fetch failed')
    expect(d.stopReason?.reason).toBe('connection')
  })

  it('无正文：写一条短 ❌，且不把多行 hint 塞进 content', () => {
    const d = resolveErrorDisplay({
      hadText: false,
      hint: '**连不上服务商**\n\n检查代理',
      message: '[connection] ENOTFOUND',
      reason: 'connection',
    })
    expect(d.content).toBe('❌ [connection] ENOTFOUND')
    expect(d.content).not.toContain('检查代理')
    expect(d.stopReason?.message).toContain('检查代理')
  })

  it('无正文且 hint/message 都缺：至少给默认横幅，不写空 content', () => {
    const d = resolveErrorDisplay({ hadText: false, fallback: '任务被中断' })
    expect(d.content).toBe('❌ 任务被中断')
    expect(d.stopReason).toBeUndefined()
  })

  it('reason 缺失时兜底为 error（横幅配色/续跑逻辑读它）', () => {
    const d = resolveErrorDisplay({ hadText: true, message: 'boom' })
    expect(d.stopReason?.reason).toBe('error')
  })

  it('非字符串 hint 一律忽略（旧后端可能送 null/对象）', () => {
    const d = resolveErrorDisplay({ hadText: true, hint: { a: 1 }, message: 'boom' })
    expect(d.stopReason?.message).toBe('boom')
  })
})
