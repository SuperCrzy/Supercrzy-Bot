/**
 * 空回复判定（P2 #6 归因，2026-09-29）。
 *
 * 真实库统计：160 条 assistant 中 9 条（5.6%）content 为空，且这 9 条的 `created_at`
 * 与上一条 user 消息**精确到同一秒**、`elapsed_ms` 为 NULL ⇒ 行在轮次开始时就建好了、
 * 这一轮始终没产出（不是"内容丢失"）。7 条连 `attachments` 都是空的。
 *
 * 这里钉的是**判据的边界**：只有"连过程都没有"才算空白。
 * 边界写松了会把正常消息（比如只跑了工具、还在思考的行）误标成"被中断"，
 * 写紧了则那 7 条空白气泡照旧没有解释。
 */
import { describe, expect, it } from 'vitest'
import type { ChatFlowNode } from '@/types'
import { isBlankAssistantTurn } from './chat'

const thinking = { id: 't', kind: 'thinking', turn: 1, message: '', reasoning: 'x', completed: true } as unknown as ChatFlowNode
const tool = { kind: 'tool', tool: { id: 'c1', name: 'shell_exec', arguments: '', status: 'success' } } as unknown as ChatFlowNode
const text = { id: 'x', kind: 'text', text: '你好' } as unknown as ChatFlowNode

describe('isBlankAssistantTurn', () => {
  it('无正文 + 无过程 → 空白（真实库那 7 条的形态：attachments 也为空）', () => {
    expect(isBlankAssistantTurn({ role: 'assistant', content: '' }, [])).toBe(true)
    expect(isBlankAssistantTurn({ role: 'assistant', content: '' }, undefined)).toBe(true)
  })

  it('有正文 → 不是空白', () => {
    expect(isBlankAssistantTurn({ role: 'assistant', content: '答案' }, [text])).toBe(false)
    // content 是 ContentBlock[] 形态（加载后）也要认
    expect(isBlankAssistantTurn({ role: 'assistant', content: [{ type: 'text', text: '答案' }] }, [])).toBe(false)
  })

  it('只有空白正文（空格/换行）+ 无过程 → 仍算空白', () => {
    expect(isBlankAssistantTurn({ role: 'assistant', content: '   \n ' }, [])).toBe(true)
  })

  it('🔴 只有 thinking 节点也算空白（思考块不算"产出"）', () => {
    expect(isBlankAssistantTurn({ role: 'assistant', content: '' }, [thinking])).toBe(true)
  })

  it('有工具过程 → 不是空白（这一轮跑了工具，不该被标成中断）', () => {
    expect(isBlankAssistantTurn({ role: 'assistant', content: '' }, [thinking, tool])).toBe(false)
  })

  it('user 消息永不被判为空白轮次', () => {
    expect(isBlankAssistantTurn({ role: 'user', content: '' }, [])).toBe(false)
  })
})
