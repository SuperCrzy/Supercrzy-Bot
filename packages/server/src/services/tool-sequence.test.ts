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

  it('孤立 tool_calls（assistant 声明但 tool 结果缺失）→ 补占位 tool 消息防止 400', () => {
    // 场景：检查点/中断后，assistant 带 tool_calls 但没有 tool 响应
    const msgs = [sys, usr, asstTool(['a']), asst('next without tool result')]
    const out = sanitizeToolCallSequence(msgs)
    // 应为 asstTool 补一条 tool 占位消息
    const toolMsgs = out.filter(m => m.role === 'tool')
    expect(toolMsgs.length).toBeGreaterThan(0)
    expect(toolMsgs[0].tool_call_id).toBe('a')
  })

  it('同轮多个 tool_calls 仅部分有工具结果 → 补缺失的占位', () => {
    // assistant 请求 a,b,c 三个 tool，但只有 a,b 有 tool 响应 → 补 c
    const msgs = [sys, usr, asstTool(['a', 'b', 'c']), tool('a'), tool('b'), asst('final')]
    const out = sanitizeToolCallSequence(msgs)
    const toolIds = out.filter(m => m.role === 'tool').map(m => m.tool_call_id)
    expect(toolIds).toContain('a')
    expect(toolIds).toContain('b')
    expect(toolIds).toContain('c') // c 被补上
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
