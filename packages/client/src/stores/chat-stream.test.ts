/**
 * chat-stream 正文分段的不变量测试（P0 修复，2026-09-29）。
 *
 * ## 症状（老板真机截图）
 *
 * ```
 * I'll research this with real sources. Let me set up a plan and start searching
 * .                                    ← 一个孤立的句号，单独一段
 * 通用搜索返回的多是导航站/聚合页，质量低。…
 * ```
 *
 * ## 根因
 *
 * 旧 `appendText` 的判据是「flow 的**最后一个节点**是不是 text」。但工具卡在
 * `tool_args_chunk` 阶段就进了 flow（`utils/agent-flow.ts` 的 `applyToolArgsChunk`
 * 找不到匹配节点即 `msg.flow.push(node)`），而一条旁白的尾片经常落在那之后：
 *
 * ```
 * content_chunk 「…start searching」   ← 旁白还在流
 * ← tool_args_chunk 开始               ← 客户端此刻 push 工具卡 ⇒ 最后节点不再是 text
 * content_chunk 「.」                  ← 尾片被当成「新段落」
 * ```
 *
 * ## 为什么这些断言抓得住它
 *
 * 每一条都编码了「**旧实现下必然为假**」的命题：旧实现会产出
 * `text('…start searching') + tool + text('.')`，于是
 * 「尾片回收到原段」「不存在纯标点的正文节点」两条断言同时红。
 * 反例（不要这样写）：断言 `flow.length === 2` 之类的**结构计数**在别的 bug 下
 * 也会变，抓不住本条。
 */
import { describe, expect, it } from 'vitest'
import type { ChatFlowNode, ChatMessage } from '@/types'
import { createChatStream } from './chat-stream'

function makeMsg(): ChatMessage {
  return { role: 'assistant', content: '', flow: [] } as unknown as ChatMessage
}

function texts(flow: ChatFlowNode[] | undefined): string[] {
  return (flow || []).filter((n) => n.kind === 'text').map((n) => (n as any).text as string)
}

function kinds(flow: ChatFlowNode[] | undefined): string[] {
  return (flow || []).map((n) => n.kind)
}

/** 模拟 `applyToolArgsChunk` 在**参数增量**阶段建的工具占位卡（id 常为空、status 仍 running） */
function pushToolPlaceholder(msg: ChatMessage, name = 'shell_exec', id = '') {
  msg.flow!.push({
    kind: 'tool',
    tool: { id, name, arguments: '', status: 'running' },
  } as unknown as ChatFlowNode)
}

/** 纯标点/空白构成的正文节点 = 那个「孤立的句号」 */
const PUNCT_ONLY = /^[\s.。！!？?,，、;；:：…]+$/

describe('chat-stream 正文分段（P0：旁白被工具卡劈成两半）', () => {
  it('参数增量期间到达的旁白尾片必须回收到原段，而不是另起一段', () => {
    const msg = makeMsg()
    const stream = createChatStream(msg)

    stream.pushText('第二步：我现在数一下当前目录下有多少')
    stream.flushTextNow()
    pushToolPlaceholder(msg) // ← 工具卡此刻进 flow，旧判据就是被这一步带偏的
    stream.pushText('个 .md 文件。')
    stream.flushTextNow()

    expect(texts(msg.flow)).toEqual(['第二步：我现在数一下当前目录下有多少个 .md 文件。'])
    // 顺序：完整正文在前、工具卡在后（而不是正文被劈成两半夹着工具卡）
    expect(kinds(msg.flow)).toEqual(['text', 'tool'])
  })

  it('英文场景同款：尾片是单个句点时也不允许出现"只有标点的正文节点"', () => {
    const msg = makeMsg()
    const stream = createChatStream(msg)

    stream.pushText('Let me set up a plan and start searching')
    stream.flushTextNow()
    pushToolPlaceholder(msg)
    stream.pushText('.')
    stream.flushTextNow()

    expect(texts(msg.flow).filter((t) => PUNCT_ONLY.test(t))).toEqual([])
    expect(texts(msg.flow)).toEqual(['Let me set up a plan and start searching.'])
  })

  it('closeTextSegment 之后（工具真的被调用），下一段正文另起新 text 节点且排在工具卡之后', () => {
    const msg = makeMsg()
    const stream = createChatStream(msg)

    stream.pushText('第一段旁白')
    stream.flushTextNow()
    pushToolPlaceholder(msg, 'shell_exec', 'call_1')
    stream.closeTextSegment() // ← ChatView 的 case 'tool_call' 会调这一句
    stream.pushText('第二段旁白')
    stream.flushTextNow()

    expect(texts(msg.flow)).toEqual(['第一段旁白', '第二段旁白'])
    expect(kinds(msg.flow)).toEqual(['text', 'tool', 'text'])
  })

  it('不变量：token 到 done 前，工具卡之后的正文永远是新段落（不会被并回工具前那一段）', () => {
    const msg = makeMsg()
    const stream = createChatStream(msg)

    // 两轮工具：每轮都是「旁白尾片 → 参数流 → tool_call → 结果 → 下一段旁白」
    for (const [head, tail, name] of [
      ['先看看目录里有多少', '个文件。', 'shell_exec'],
      ['再读一下 README，', '看构建方式。', 'file_read'],
    ] as const) {
      stream.pushText(head)
      stream.flushTextNow()
      pushToolPlaceholder(msg, name) // 参数增量：尾片还没到
      stream.pushText(tail)
      stream.flushTextNow()
      stream.closeTextSegment() // tool_call
    }

    expect(texts(msg.flow)).toEqual(['先看看目录里有多少个文件。', '再读一下 README，看构建方式。'])
    expect(texts(msg.flow).filter((t) => PUNCT_ONLY.test(t))).toEqual([])
  })

  it('图节点也是分段边界：图后的正文另起节点（顺序不乱）', () => {
    const msg = makeMsg()
    const stream = createChatStream(msg)

    stream.pushText('下面是流程图：')
    stream.flushTextNow()
    stream.appendDiagramChunk('<svg viewBox="0 0 1 1">')
    stream.pushText('看完图我们继续。')
    stream.flushTextNow()

    expect(kinds(msg.flow)).toEqual(['text', 'diagram', 'text'])
    expect(texts(msg.flow)).toEqual(['下面是流程图：', '看完图我们继续。'])
  })

  it('finish(content)：末段还是旁白时另起正文节点，且**不留空节点**', async () => {
    const msg = makeMsg()
    const stream = createChatStream(msg)

    stream.pushText('过程旁白')
    stream.flushTextNow()
    stream.closeTextSegment() // 工具调用发生过
    await stream.finish('最终答案')

    // 旧实现（finish 里不重开正文段）会得到 ['过程旁白', '', '最终答案']
    expect(texts(msg.flow)).toEqual(['过程旁白', '最终答案'])
  })

  it('finish(content)：末段是答案前缀时补齐到全文，不另起节点', async () => {
    const msg = makeMsg()
    const stream = createChatStream(msg)

    stream.pushText('旁白')
    stream.flushTextNow()
    stream.closeTextSegment()
    stream.pushText('答案前半')
    stream.flushTextNow()
    await stream.finish('答案前半后半')

    expect(texts(msg.flow)).toEqual(['旁白', '答案前半后半'])
  })
})
