import { describe, it, expect } from 'vitest'
import { markTurnAborted } from './turn-abort'
import type { ChatMessage } from '@/types'

const assistant = (over: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'assistant', content: '', ...over } as ChatMessage)

describe('markTurnAborted', () => {
  it('纯文本中断（没有 flow / 没有在跑工具）同样标记取消 —— 否则徽标整块消失', () => {
    const msgs = [assistant({ content: '半句话' })]
    markTurnAborted(msgs)
    expect(msgs[0].isAborted).toBe(true)
  })

  it('只标记最后一条 assistant，不污染历史轮次', () => {
    const msgs = [assistant({ content: 'a' }), { role: 'user', content: 'q' } as ChatMessage, assistant({ content: 'b' })]
    markTurnAborted(msgs)
    expect(msgs[0].isAborted).toBeUndefined()
    expect(msgs[2].isAborted).toBe(true)
  })

  it('有起点就冻结耗时（取消态不跑秒针，必须留下定格值）', () => {
    const msgs = [assistant({ startedAt: 1000 })]
    markTurnAborted(msgs, 9000)
    expect(msgs[0].elapsedMs).toBe(8000)
  })

  it('已有 elapsedMs 不覆盖（例如 done 已写入的精确值）', () => {
    const msgs = [assistant({ startedAt: 1000, elapsedMs: 4000 })]
    markTurnAborted(msgs, 9000)
    expect(msgs[0].elapsedMs).toBe(4000)
  })

  it('在跑的工具置 cancelled；已终态的工具不动', () => {
    const msgs = [assistant({
      flow: [
        { kind: 'tool', tool: { id: 'a', name: 'file_read', status: 'done', arguments: '{}' } },
        { kind: 'tool', tool: { id: 'b', name: 'shell_exec', status: 'running', arguments: '{}' } },
        { kind: 'tool', tool: { id: 'c', name: 'web_fetch', status: 'pending', arguments: '{}' } },
      ],
    } as Partial<ChatMessage>)]
    markTurnAborted(msgs)
    const st = (msgs[0].flow as any[]).map((n) => n.tool.status)
    expect(st).toEqual(['done', 'cancelled', 'cancelled'])
  })

  it('空列表不抛', () => {
    expect(() => markTurnAborted([])).not.toThrow()
  })
})
