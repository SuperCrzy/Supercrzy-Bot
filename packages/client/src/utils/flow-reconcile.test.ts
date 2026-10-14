/**
 * flow × content 对账的不变量测试（I15）。
 *
 * 核心回归：**真实库样本复现** —— 2026-09-24 从 `~/.supercrzy/data/supercrzy.db`
 * 取出的 assistant 消息 `e66828bd`（会话 `fc05c79b`）：
 *   content = 1441 字（最终答案全文，完整无缺）
 *   flow text 段 = 56 + 57 + 56 + 1272 = 1441
 *   最后一段（1272）= content[0:68] + content[237:1441]  ← **中间 169 字被吃掉**
 *   169 = 三段过程旁白之和；237 = 68 + 169
 *
 * 旧实现：`tail = content.slice(concat(所有 text 段).length)` = `content.slice(237)`
 * → 末段 = 68 + 1204 = 1272，答案被挖洞，且总长恰好等于 content 长度（长度对比看不出问题）。
 * 新实现：偏移只能取「最后一段自身长度」= 68 → `content.slice(68)` → 末段 = 1441 = content。
 */
import { describe, expect, it } from 'vitest'
import type { ChatFlowNode } from '@/types'
import { answerTailForLastText, isAnswerNode, reconcileAnswerText } from './flow-reconcile'

/** 造一条真实库形状的消息（旁白 + 工具 + 最终答案） */
function makeFlow(narrations: string[], answerPartial: string): ChatFlowNode[] {
  const flow: ChatFlowNode[] = [{ id: 't0', kind: 'thinking', turn: 1, message: '', reasoning: '', completed: true }]
  narrations.forEach((n, i) => {
    flow.push({ id: `tool${i}`, kind: 'tool' } as unknown as ChatFlowNode)
    flow.push({ id: `tx${i}`, kind: 'text', text: n })
  })
  flow.push({ id: 'tool-last', kind: 'tool' } as unknown as ChatFlowNode)
  flow.push({ id: 'tx-final', kind: 'text', text: answerPartial })
  return flow
}

const textOf = (flow: ChatFlowNode[]) =>
  flow.filter((n) => n.kind === 'text').map((n) => (n as any).text as string)

describe('reconcileAnswerText', () => {
  it('修复真实库缺口样本：末段补齐到 content 全文（不是被挖洞的 1272）', () => {
    const answer = 'A'.repeat(1441)
    const narr = ['N'.repeat(56), 'N'.repeat(57), 'N'.repeat(56)]
    const flow = makeFlow(narr, answer.slice(0, 68)) // 打字机只播到 68

    // 旁白总长 169：旧实现的偏移（拼接长度）= 56+57+56+68 = 237
    const concatLen = narr.reduce((s, n) => s + n.length, 0) + 68
    expect(concatLen).toBe(237)
    // 旧实现产物 = 68 + content.slice(237).length = 1272（缺 169 字）
    expect(68 + (answer.length - 237)).toBe(1272)
    expect(answer.slice(237)).not.toBe(answer.slice(68))

    const res = reconcileAnswerText(flow, answer)
    expect(res.action).toBe('filled')
    expect(res.previousLastLen).toBe(68)
    const texts = textOf(res.flow)
    expect(texts[texts.length - 1]).toBe(answer)
    expect(texts[texts.length - 1].length).toBe(1441)
    // 旁白一字不动
    expect(texts.slice(0, -1)).toEqual(narr)
  })

  it('幂等：重复调用第二次起为 noop 且内容不变', () => {
    const answer = 'B'.repeat(500)
    const flow = makeFlow(['P'.repeat(20)], answer.slice(0, 100))
    const r1 = reconcileAnswerText(flow, answer)
    expect(r1.action).toBe('filled')
    const r2 = reconcileAnswerText(r1.flow, answer)
    expect(r2.action).toBe('noop')
    expect(r2.flow).toBe(r1.flow) // 未改动 → 返回原数组引用
    expect(textOf(r2.flow).pop()).toBe(answer)
  })

  it('末段超播（比 content 长且以 content 开头）→ 裁到 content', () => {
    const answer = 'C'.repeat(300)
    const flow = makeFlow([], answer + '```svg junk```')
    const res = reconcileAnswerText(flow, answer)
    expect(res.action).toBe('trimmed')
    expect(textOf(res.flow).pop()).toBe(answer)
  })

  it('末段是过程旁白（与 content 无前缀关系）→ 另起正文节点，旁白不丢', () => {
    const answer = 'D'.repeat(200)
    // 关键：flow 的**最后一段**是旁白（答案还没开始播）——不能用空串节点占位
    const flow: ChatFlowNode[] = [
      { id: 't0', kind: 'thinking', turn: 1, message: '', reasoning: '', completed: true },
      { id: 'tx1', kind: 'text', text: '我先查一下日志' },
      { id: 'tool1', kind: 'tool' } as unknown as ChatFlowNode,
      { id: 'tx2', kind: 'text', text: '日志里没有报错' },
    ]
    const res = reconcileAnswerText(flow, answer)
    expect(res.action).toBe('appended')
    const texts = textOf(res.flow)
    expect(texts).toEqual(['我先查一下日志', '日志里没有报错', answer])
    // 追加在末尾（= 最终报告位置）
    expect(res.flow[res.flow.length - 1].kind).toBe('text')
  })

  it('flow 无 text 节点 → 新建；answer 为空 → noop', () => {
    const bare: ChatFlowNode[] = [{ id: 't0', kind: 'thinking', turn: 1, message: '', reasoning: '', completed: true }]
    const created = reconcileAnswerText(bare, 'E')
    expect(created.action).toBe('created')
    expect(textOf(created.flow)).toEqual(['E'])

    const noop = reconcileAnswerText(bare, '')
    expect(noop.action).toBe('noop')
    expect(noop.flow).toBe(bare)
    expect(noop.previousLastLen).toBe(-1)
  })

  it('不改动入参（纯函数）', () => {
    const flow = makeFlow(['x'], 'y')
    const snapshot = JSON.stringify(flow)
    reconcileAnswerText(flow, 'y' + 'z'.repeat(10))
    expect(JSON.stringify(flow)).toBe(snapshot)
  })
})

describe('isAnswerNode', () => {
  it('空末段视为答案占位；单 text 段消息（无旁白）恒成立', () => {
    expect(isAnswerNode('', 'abc')).toBe(true)
    expect(isAnswerNode('ab', 'abc')).toBe(true) // 前缀
    expect(isAnswerNode('abcd', 'abc')).toBe(true) // 超播
    expect(isAnswerNode('xyz', 'abc')).toBe(false)
    expect(isAnswerNode('ab', '')).toBe(false)
  })
})

describe('answerTailForLastText', () => {
  const only = (t: string): ChatFlowNode[] => [{ id: 'x', kind: 'text', text: t }]

  it('末段是答案前缀 → 返回剩余待播', () => {
    const answer = 'F'.repeat(100)
    expect(answerTailForLastText(only(answer.slice(0, 30)), answer)).toBe(answer.slice(30))
  })

  it('末段超播 → 空串（无需再播）', () => {
    const answer = 'F'.repeat(100)
    expect(answerTailForLastText(only(answer + 'q'), answer)).toBe('')
  })

  it('末段是空串占位 → 从头播全文', () => {
    const answer = 'F'.repeat(100)
    expect(answerTailForLastText(only(''), answer)).toBe(answer)
  })

  it('末段是过程旁白 → null（调用方必须另起正文节点，不能粘在旁白后面）', () => {
    const answer = 'F'.repeat(100)
    expect(answerTailForLastText(only('完全不相干的一段过程旁白'), answer)).toBe(null)
  })

  it('无任何 text 节点 → 全文', () => {
    expect(answerTailForLastText([], 'abc')).toBe('abc')
  })
})
