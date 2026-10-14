import { describe, it, expect, beforeEach } from 'vitest'
import { sanitizeToolCallSequence, hasOrphanToolCalls, ensureReasoningEcho, requestStop, isStopRequested, clearStop } from './agent'

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

// ---- 2026-10-14：撤除"缺 rc 就整轮降级"这条旧规则 ----
// 08-28 曾据"必须原样传回 rc"把它做成降级判据；09-20 的对照实验推翻了该前提：
// 带 tools 时**最后一条 user 之后**的尾部每条 assistant 都必须带 rc **字段**（空串即满足），
// 更早的历史回合缺 rc 本就无害。而旧降级会把 tool_calls 与其 tool 响应一起删掉
// ⇒ 静默丢工具历史（API 照常 200）：saveCheckpoint(:992) 与恢复(:1116) 都会踩到。
// 故本组用例反向锁定：**缺 rc 不得触发降级**。
describe('缺 reasoning_content 不得触发降级（2026-10-14 撤除旧判据）', () => {
  const asstToolWithRc = (ids: string[], rc: string) => ({
    role: 'assistant' as const, content: '',
    reasoning_content: rc,
    tool_calls: ids.map(id => ({ id, type: 'function' as const, function: { name: 'web_search', arguments: '{}' } })),
  })
  const asstRc = (rc: string, content = 'x') => ({ role: 'assistant' as const, content, reasoning_content: rc })

  it('已配对但缺 rc 的 tool_calls 必须完整保留（旧实现会整轮降级把它删掉）', () => {
    // 一轮带 rc 的正常工具调用 → 序列处于推理模式
    // 一轮带 tool_calls 但缺 rc（模型该轮没输出思考）→ 旧实现整轮降级，本轮起就不该再发生
    const msgs = [
      sys, usr,
      asstToolWithRc(['a'], '思考A'), tool('a'),
      asstTool(['b']), tool('b'),   // 缺 rc
      asst('done'),
    ]
    expect(hasOrphanToolCalls(msgs)).toBe(false)

    const out = sanitizeToolCallSequence(msgs)
    // 两轮都必须保留：sanitize 只看配对，不看 rc
    expect(out).toHaveLength(msgs.length)
    const keptIds = out
      .filter(m => m.role === 'assistant' && (m as any).tool_calls)
      .flatMap((m: any) => m.tool_calls.map((tc: any) => tc.id))
    expect(keptIds).toEqual(['a', 'b'])
    expect(out.filter(m => m.role === 'tool').map(m => (m as any).tool_call_id)).toEqual(['a', 'b'])
  })

  it('非推理模式（全程无 rc）不误伤：普通模型的工具调用必须完整保留', () => {
    // 关键安全闸门：GPT/Claude 等本就没有 rc，若不加判断会删光所有工具调用
    const msgs = [sys, usr, asstTool(['a']), tool('a'), asstTool(['b']), tool('b'), asst('done')]
    expect(hasOrphanToolCalls(msgs)).toBe(false)
    const out = sanitizeToolCallSequence(msgs)
    expect(out.filter(m => m.role === 'assistant' && (m as any).tool_calls)).toHaveLength(2)
    expect(out.filter(m => m.role === 'tool')).toHaveLength(2)
  })

  it('rc 为空串或纯空白同样不算缺失', () => {
    const msgs = [sys, usr, asstRc('有思考'), asstToolWithRc(['a'], '   '), tool('a')]
    expect(hasOrphanToolCalls(msgs)).toBe(false)

    const msgs2 = [sys, usr, asstRc('有思考'), asstToolWithRc(['a'], ''), tool('a')]
    expect(hasOrphanToolCalls(msgs2)).toBe(false)

    // 连"缺字段"也不算缺失 —— rc 根本不是本函数的判据（补齐归 ensureReasoningEcho）
    expect(hasOrphanToolCalls([sys, usr, asstRc('有思考'), asstTool(['a']), tool('a')])).toBe(false)
  })

  it('🔴 防线断言：rc 取 undefined / "" / 纯空白 / 有值，sanitize 后 tool_calls 数量必须一致', () => {
    // 这条在 2026-10-14 的 bug 存在时**会变红**（rc 为 undefined/空串/纯空白都会让工具轮被整轮降级）。
    // 变红时的正确做法是修 sanitizeToolCallSequence，而不是删掉这条断言。
    const shape = (rc: string | undefined) => {
      const tail: any = {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'b', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
      }
      if (rc !== undefined) tail.reasoning_content = rc
      return [sys, usr, asstToolWithRc(['a'], '思考A'), tool('a'), tail, tool('b')]
    }
    const callsKept = (msgs: any[]) => sanitizeToolCallSequence(msgs)
      .filter(m => m.role === 'assistant' && (m as any).tool_calls)
      .reduce((n: number, m: any) => n + m.tool_calls.length, 0)
    const toolKept = (msgs: any[]) => sanitizeToolCallSequence(msgs)
      .filter(m => m.role === 'tool').length

    for (const rc of [undefined, '', '   ', '思考B'] as const) {
      expect(callsKept(shape(rc)), `rc=${JSON.stringify(rc)}`).toBe(2)
      expect(toolKept(shape(rc)), `rc=${JSON.stringify(rc)}`).toBe(2)
    }
  })
})

// ---- 2026-09-20：真规则不是"缺 rc 就要原样传回"，而是 ----
//   请求带 tools 时，**最后一条 user 消息之后**的尾部里，每条 assistant 都必须带
//   reasoning_content **字段**（空串也满足）。更早的历史回合缺 rc 无害；带 tool_calls 的更不受影响。
//   实测依据（可重跑）：scripts/diag/confirm-rc-rule.ts + scripts/diag/acceptance-rc-fix.ts
//   —— 3 个真实失败检查点走旧管线仍 400 RC，加 ensureReasoningEcho 后 6/6 全 200。
describe('ensureReasoningEcho（2026-09-20 修复 reasoning_content must be passed back）', () => {
  const DS = { withTools: true, model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1' }
  const rcOf = (m: any) => m.reasoning_content

  it('尾部缺 rc 字段的 assistant 补空串；最后一条 user 之前的历史回合不动', () => {
    const msgs = [sys, asst('历史无rc'), usr, asst('尾部无rc')]
    const out = ensureReasoningEcho(msgs, DS)
    expect(rcOf(out[1])).toBeUndefined()      // 历史回合：不碰（省 token、避免无谓 diff）
    expect(rcOf(out[3])).toBe('')             // 尾部：补空串
  })

  it('尾部已有 rc 字段时原样返回（含空串，不产生无谓改写）', () => {
    const msgs: any[] = [sys, usr, { role: 'assistant', content: 'a', reasoning_content: '思考' },
                         { role: 'assistant', content: 'b', reasoning_content: '' }]
    const out = ensureReasoningEcho(msgs, DS)
    expect(out).toBe(msgs)                    // 同一引用，零改写
  })

  it('末条不是 assistant（如 tool）→ 不需要补', () => {
    const msgs = [sys, usr, asstTool(['a']), tool('a')]
    const out = ensureReasoningEcho(msgs, DS)
    expect(rcOf(out[2])).toBe('')             // tc 型尾部 assistant 同样在射程内
    expect(rcOf(out[3])).toBeUndefined()      // tool 消息不补
  })

  it('不带 tools 时是空操作（实测：同一序列不带 tools → 200，tools 才是触发开关）', () => {
    const msgs: any[] = [sys, usr, asst('无rc')]
    const out = ensureReasoningEcho(msgs, { ...DS, withTools: false })
    expect(rcOf(out[2])).toBeUndefined()
    expect(out).toBe(msgs)
  })

  it('非 DeepSeek 模型不注入（reasoning_content 是 DeepSeek 私有协议，注入别家可能被拒）', () => {
    const msgs: any[] = [sys, usr, asst('无rc')]
    expect(rcOf(ensureReasoningEcho(msgs, { withTools: true, model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' })[2])).toBeUndefined()
    expect(rcOf(ensureReasoningEcho(msgs, { withTools: true, model: 'claude-3-5-sonnet', baseUrl: 'https://api.anthropic.com' })[2])).toBeUndefined()
    // baseUrl 含 deepseek 即认定为该系
    expect(rcOf(ensureReasoningEcho(msgs, { withTools: true, model: 'custom-x', baseUrl: 'https://api.deepseek.com/v1' })[2])).toBe('')
  })

  it('幂等：补过之后再补不变', () => {
    const msgs: any[] = [sys, usr, asst('无rc')]
    const once = ensureReasoningEcho(msgs, DS)
    expect(ensureReasoningEcho(once, DS)).toBe(once)
  })

  it('降级必须保留 rc —— 旧实现把 rc 丢掉，自己造出了它想修的那个 400', () => {
    // tool 结果缺失 → 该轮必须降级；但 rc 不能跟着丢
    const msgs: any[] = [sys, usr,
      { role: 'assistant', content: '', reasoning_content: '思考A', tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }] }]
    const out = sanitizeToolCallSequence(msgs)
    const demoted = out[out.length - 1] as any
    expect(demoted.tool_calls).toBeUndefined()
    expect(demoted.reasoning_content).toBe('思考A')
    // 端到端：降级 + 补 rc 之后不再需要任何修补
    expect(ensureReasoningEcho(out, DS)).toBe(out)
  })

  it('端到端：真实失败形状（降级丢 rc 落在尾部）在旧管线 400、新管线被补齐', () => {
    const brokenTail = { role: 'assistant' as const, content: '（该轮工具调用记录不完整，已省略）' }
    const msgs: any[] = [sys, usr, asstTool(['a']), tool('a'), brokenTail]
    // 旧行为：原样发出去就是这个形状 → DeepSeek 400
    expect(rcOf(msgs[4])).toBeUndefined()
    // 新管线：尾部被补齐
    const fixed = ensureReasoningEcho(sanitizeToolCallSequence(msgs), DS)
    expect(rcOf(fixed[4])).toBe('')
  })
})

// ---- 2026-09-20：反向孤立（tool 消息找不到发起者）----
// 来源：上下文压缩按 token 把 head/tail 切开，assistant 落进 middle 被摘要掉，tool 消息留在 tail。
// 触发 400 "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'"
describe('反向孤立 tool 消息（2026-09-20 补）', () => {
  it('tool 消息的 tool_call_id 无发起者 → 移除', () => {
    const msgs = [sys, usr, asst('汇总'), tool('ghost'), { role: 'user' as const, content: 'x' }]
    expect(hasOrphanToolCalls(msgs)).toBe(true)
    expect(sanitizeToolCallSequence(msgs).filter(m => m.role === 'tool')).toHaveLength(0)
  })

  it('发起者被降级 → 其 tool 消息一并移除', () => {
    // 'a' 有响应、'b' 无响应 → 整轮降级，a 的 tool 消息也必须走
    const msgs = [sys, usr, asstTool(['a', 'b']), tool('a'), asst('done')]
    const out = sanitizeToolCallSequence(msgs)
    expect(out.filter(m => m.role === 'tool')).toHaveLength(0)
    expect(hasOrphanToolCalls(out)).toBe(false)
  })

  it('正常配对的 tool 消息不受影响（不误删）', () => {
    const msgs = [sys, usr, asstTool(['a']), tool('a'), asstTool(['b']), tool('b')]
    const out = sanitizeToolCallSequence(msgs)
    expect(out.filter(m => m.role === 'tool')).toHaveLength(2)
    expect(hasOrphanToolCalls(out)).toBe(false)
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
