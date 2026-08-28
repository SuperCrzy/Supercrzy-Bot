import { describe, it, expect } from 'vitest'
import { sanitizeToolCallSequence, hasOrphanToolCalls } from './agent'

// 构造最小 AgentMessage
const sys = { role: 'system' as const, content: 's' }
const usr = { role: 'user' as const, content: 'u' }
const asst = (content: string) => ({ role: 'assistant' as const, content })
// type 必须 as const，否则推断成 string 无法赋给 ToolCall（type: 'function'）
const asstTool = (ids: string[], content = '') => ({ role: 'assistant' as const, content, tool_calls: ids.map(id => ({ id, type: 'function' as const, function: { name: 'web_search', arguments: '{}' } })) })
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

  // ---- 2026-08-28：检查点是坏序列的唯一持久化来源（实测 196 个中 14 个带孤立项），
  //      保存/恢复两侧都必须清洗，否则续跑首轮必 400 ----
  it('hasOrphanToolCalls：有孤立返回 true，全配对返回 false', () => {
    expect(hasOrphanToolCalls([sys, usr, asstTool(['a']), asst('x')])).toBe(true)
    expect(hasOrphanToolCalls([sys, usr, asstTool(['a']), tool('a')])).toBe(false)
    expect(hasOrphanToolCalls([sys, usr, asst('plain')])).toBe(false)
  })

  it('检查点场景：sanitize 后 hasOrphanToolCalls 必为 false（模拟 save/restore 两侧清洗）', () => {
    // 模拟检查点在"assistant 已发 tool_calls、tool 结果未回"时落盘
    const saved = [sys, usr, asstTool(['a', 'b']), tool('a'), asstTool(['c'])]
    expect(hasOrphanToolCalls(saved)).toBe(true) // 'b' 和 'c' 都孤立

    const restored = sanitizeToolCallSequence(saved)
    expect(hasOrphanToolCalls(restored)).toBe(false) // 恢复侧清洗后干净
    expect(restored.length).toBe(saved.length)       // 降级不改条数
  })

  it('清洗是幂等的：清洗过的结果再清洗一次不变', () => {
    const msgs = [sys, usr, asstTool(['a']), asst('next')]
    const once = sanitizeToolCallSequence(msgs)
    const twice = sanitizeToolCallSequence(once)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })
})
