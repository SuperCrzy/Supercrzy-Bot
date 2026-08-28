import { describe, it, expect } from 'vitest'
import { sanitizeToolCallSequence } from './agent'

// 构造最小 AgentMessage
const sys = { role: 'system' as const, content: 's' }
const usr = { role: 'user' as const, content: 'u' }
const asst = (content: string) => ({ role: 'assistant' as const, content })
const asstTool = (ids: string[], content = '') => ({ role: 'assistant' as const, content, tool_calls: ids.map(id => ({ id, type: 'function', function: { name: 'web_search', arguments: '{}' } })) })
const tool = (id: string, content = 'ok') => ({ role: 'tool' as const, tool_call_id: id, content })

describe('sanitizeToolCallSequence（2026-08-28 修复 400 孤立 tool_calls）', () => {
  it('正常配对序列不变（assistant tool_calls 后都有 tool 响应）', () => {
    const msgs = [sys, usr, asstTool(['a', 'b']), tool('a'), tool('b'), asst('final')]
    const out = sanitizeToolCallSequence(msgs)
    expect(out.length).toBe(6)
    // 保持原序（含 tool_calls 的那个 assistant 不动，因为它有配对）
    expect((out[2] as any).tool_calls).toHaveLength(2)
  })

  it('孤立 tool_calls（assistant 声明但 tool 结果缺失）→ 降级纯文本防 400', () => {
    // 场景：检查点/中断后，assistant 带 tool_calls 但没有 tool 响应
    const msgs = [sys, usr, asstTool(['a']), asst('next without tool result')]
    const out = sanitizeToolCallSequence(msgs)
    // 原 asstTool 应被降级为纯文本，不再带 tool_calls
    const asstWithCalls = out.filter(m => m.role === 'assistant' && (m as any).tool_calls)
    expect(asstWithCalls.length).toBe(0)
    // 且不超过原条数（没新增）
    expect(out.length).toBeLessThanOrEqual(msgs.length)
  })

  it('同轮多个 tool_calls 仅部分有工具结果 → 整体降级（不留半孤儿）', () => {
    // assistant 请求 a,b,c 三个 tool，但只有 a,b 有 tool 响应 → c 孤立 → 整条保持 tool_calls 但需 c 被响应。
    // 新策略：任一孤立则整条降级为纯文本（最安全）。
    const msgs = [sys, usr, asstTool(['a', 'b', 'c']), tool('a'), tool('b'), asst('final')]
    const out = sanitizeToolCallSequence(msgs)
    const asstWithCalls = out.find(m => m.role === 'assistant' && (m as any).tool_calls)
    expect(asstWithCalls).toBeUndefined() // c 孤立 → 整条降级
  })

  it('连续多轮正常工具调用不误伤', () => {
    const msgs = [
      sys, usr,
      asstTool(['a']), tool('a'),
      asstTool(['b']), tool('b'),
      asst('done'),
    ]
    const out = sanitizeToolCallSequence(msgs)
    // 两轮 tool_calls 都保留
    const calls = out.filter(m => m.role === 'assistant' && (m as any).tool_calls)
    expect(calls).toHaveLength(2)
    expect((calls[0] as any).tool_calls[0].id).toBe('a')
    expect((calls[1] as any).tool_calls[0].id).toBe('b')
  })
})
