import { afterEach, describe, it, expect, vi } from 'vitest'
import { markTurnAborted, requestAgentStop } from './turn-abort'
import type { ChatMessage } from '@/types'

const assistant = (over: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'assistant', content: '', ...over } as ChatMessage)

describe('markTurnAborted', () => {
  it('纯文本中断（没有 flow / 没有在跑工具）同样标记取消 —— 否则徽标整块消失', () => {
    const msgs = [assistant({ content: '半句话' })]
    markTurnAborted(msgs)
    expect(msgs[0].isAborted).toBe(true)
  })

  it('records the stop notice without overwriting an existing checkpoint', () => {
    const plain = assistant()
    markTurnAborted([plain], 1000, '后台任务可能仍在收尾')
    expect(plain.stopReason).toEqual({ reason: 'user_stopped', message: '后台任务可能仍在收尾' })
    const checkpoint = assistant({ stopReason: { reason: 'interrupted', message: '已暂停', checkpointId: 'ckpt' } })
    markTurnAborted([checkpoint], 1000, '后台任务可能仍在收尾')
    expect(checkpoint.stopReason?.checkpointId).toBe('ckpt')
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

  it('当前轮没有运行工具时不改写历史轮次', () => {
    const previous = assistant({ flow: [{ kind: 'tool', tool: { id: 'old', name: 'shell_exec', status: 'running', arguments: '{}' } }] })
    const current = assistant({ content: '部分回答' })
    markTurnAborted([previous, current])
    expect((previous.flow![0] as any).tool.status).toBe('running')
    expect(current.isAborted).toBe(true)
  })
})

describe('requestAgentStop', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('sends the session to the stop endpoint and accepts a successful response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await requestAgentStop('session-a')).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/stop', expect.objectContaining({ method: 'POST', body: JSON.stringify({ sessionId: 'session-a' }) }))
  })

  it('reports HTTP and network failures', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    expect(await requestAgentStop('session-a')).toBe(false)
    expect(await requestAgentStop('session-a')).toBe(false)
  })
})
