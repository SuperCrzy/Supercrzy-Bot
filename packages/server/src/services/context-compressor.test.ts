import { describe, it, expect } from 'vitest'
import { estimateMessagesTokens, shouldCompress, pruneOldToolResults } from './context-compressor'

interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: string; text?: string }>
  tool_calls?: any[]
  tool_call_id?: string
  reasoning_content?: string
}

function msg(role: AgentMessage['role'], content: string): AgentMessage {
  return { role, content }
}

describe('context-compressor', () => {
  it('estimateMessagesTokens 累加各消息 token', () => {
    const m: AgentMessage[] = [msg('user', 'hello world'), msg('assistant', 'hi there')]
    const t = estimateMessagesTokens(m)
    // 中文按字符计、英文按词计，总量必 > 0
    expect(t).toBeGreaterThan(0)
  })

  it('estimateMessagesTokens 计入 reasoning_content 与 tool_calls', () => {
    const plain: AgentMessage[] = [msg('assistant', 'x')]
    const rich: AgentMessage[] = [
      { role: 'assistant', content: 'x', reasoning_content: 'reasoning '.repeat(50), tool_calls: [{ id: '1', name: 'web_search' }] },
    ]
    expect(estimateMessagesTokens(rich)).toBeGreaterThan(estimateMessagesTokens(plain))
  })

  it('shouldCompress 超过窗口 55% 触发', () => {
    const long = '词'.repeat(30000) // 中文约 1 字 ≈ 1 token → ~30K token
    const m: AgentMessage[] = [msg('user', long)]
    // 32K 窗口 × 0.55 = 17.6K → 30K 超过
    expect(shouldCompress(m, 32000)).toBe(true)
  })

  it('shouldCompress 小消息不触发', () => {
    const m: AgentMessage[] = [msg('user', 'hi')]
    expect(shouldCompress(m, 32000)).toBe(false)
  })

  it('pruneOldToolResults 裁剪旧的超长工具结果(保留最近 N 条完整)', () => {
    const m: AgentMessage[] = []
    for (let i = 0; i < 6; i++) m.push(msg('tool', 'x'.repeat(800)))
    const pruned = pruneOldToolResults(m, 3)
    expect(pruned).toHaveLength(6) // 不删除消息
    const trimmed = pruned.filter((x) => typeof x.content === 'string' && x.content.includes('工具结果已裁剪'))
    expect(trimmed).toHaveLength(3) // 前 3 条(旧)被裁剪
    const last = pruned[5]
    expect(String(last.content)).not.toContain('工具结果已裁剪') // 最近 1 条完整保留
  })
})
