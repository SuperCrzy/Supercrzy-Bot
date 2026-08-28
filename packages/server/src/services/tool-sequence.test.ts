import { describe, it, expect, beforeEach } from 'vitest'
import { sanitizeToolCallSequence, hasOrphanToolCalls, requestStop, isStopRequested, clearStop } from './agent'

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
    // 降级后连孤儿 tool 响应一并移除（tool('a') 被删：其 tool_calls 已降级），
    // 否则 tool 消息没有配对 tool_calls，同样会触发 400
    expect(restored.filter(m => m.role === 'tool')).toHaveLength(0)
    expect(restored.filter(m => m.role === 'assistant' && (m as any).tool_calls)).toHaveLength(0)
  })

  it('清洗是幂等的：清洗过的结果再清洗一次不变', () => {
    const msgs = [sys, usr, asstTool(['a']), asst('next')]
    const once = sanitizeToolCallSequence(msgs)
    const twice = sanitizeToolCallSequence(once)
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })
})

// ---- 2026-08-28 补：推理模式下"已配对但缺 reasoning_content"的盲区 ----
// DeepSeek 深度思考硬性协议：带 tool_calls 的 assistant 必须原样传回 rc。
// 实测 199 个检查点里 55 个中招，恢复即 400 "must be passed back"。
describe('推理模式缺 reasoning_content（实测 55 个检查点中招的盲区）', () => {
  const asstToolWithRc = (ids: string[], rc: string) => ({
    role: 'assistant' as const, content: '',
    reasoning_content: rc,
    tool_calls: ids.map(id => ({ id, type: 'function' as const, function: { name: 'web_search', arguments: '{}' } })),
  })
  const asstRc = (rc: string, content = 'x') => ({ role: 'assistant' as const, content, reasoning_content: rc })

  it('推理模式下：已配对但缺 rc 的 tool_calls 被降级，且其 tool 响应一并移除', () => {
    // 一轮带 rc 的正常工具调用 → 确认处于推理模式
    // 一轮带 tool_calls 但缺 rc（模型该轮没输出思考）→ 应被整轮降级
    const msgs = [
      sys, usr,
      asstToolWithRc(['a'], '思考A'), tool('a'),
      asstTool(['b']), tool('b'),   // 缺 rc
      asst('done'),
    ]
    expect(hasOrphanToolCalls(msgs)).toBe(true)

    const out = sanitizeToolCallSequence(msgs)
    // 带 rc 的那轮保留（配对的 tool 响应也保留）
    const kept = out.filter(m => m.role === 'assistant' && (m as any).tool_calls)
    expect(kept).toHaveLength(1)
    expect((kept[0] as any).tool_calls[0].id).toBe('a')
    // 缺 rc 那轮的 tool 响应 b 被移除（否则成孤儿同样 400）
    const toolIds = out.filter(m => m.role === 'tool').map(m => (m as any).tool_call_id)
    expect(toolIds).toEqual(['a'])
    expect(hasOrphanToolCalls(out)).toBe(false)
  })

  it('非推理模式（全程无 rc）不误伤：普通模型的工具调用必须完整保留', () => {
    // 关键安全闸门：GPT/Claude 等本就没有 rc，若不加判断会删光所有工具调用
    const msgs = [sys, usr, asstTool(['a']), tool('a'), asstTool(['b']), tool('b'), asst('done')]
    expect(hasOrphanToolCalls(msgs)).toBe(false)
    const out = sanitizeToolCallSequence(msgs)
    expect(out.filter(m => m.role === 'assistant' && (m as any).tool_calls)).toHaveLength(2)
    expect(out.filter(m => m.role === 'tool')).toHaveLength(2)
  })

  it('推理模式下 rc 为空字符串同样视为缺失', () => {
    const msgs = [sys, usr, asstRc('有思考'), asstToolWithRc(['a'], '   '), tool('a')]
    expect(hasOrphanToolCalls(msgs)).toBe(true)
  })
})

// ---- 2026-08-28 新增：停止机制 ----
// 背景：此前 Agent 完全没有停止机制，前端"停止"只是断开 SSE，后端循环照跑到 maxTurns
// （复杂任务 200 轮）。实测失控案例跑到 40+ 轮、上下文 285KB，用户只能干等。
describe('停止机制 requestStop / isStopRequested / clearStop', () => {
  const key = 'session-stop-test'

  beforeEach(() => {
    clearStop(key)
  })

  it('初始未请求停止', () => {
    expect(isStopRequested(key)).toBe(false)
  })

  it('requestStop 后置位，clearStop 后复位', () => {
    expect(requestStop(key)).toBe(true)
    expect(isStopRequested(key)).toBe(true)

    clearStop(key)
    expect(isStopRequested(key)).toBe(false)
  })

  it('不同 sessionId 互不干扰', () => {
    requestStop(key)
    expect(isStopRequested('another-session')).toBe(false)
    clearStop(key)
  })

  it('空 key 不生效（防误停）', () => {
    expect(requestStop('')).toBe(false)
  })
})
