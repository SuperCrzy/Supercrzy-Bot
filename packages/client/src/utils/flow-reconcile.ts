/**
 * flow × content 对账（**唯一实现**，2026-09-24 收敛）。
 *
 * ## 不变量（用真实运行库 80 条 assistant 消息实测确认，不是推断）
 *
 * - `content`（后端 `content` 事件，即 `messages.content`）= 本轮**最终答案**。
 *   工具轮的过程旁白虽然也走 `content_chunk`，但轮末 `content` 事件会整体覆盖，
 *   **旁白不在 content 里**（实测 80 条中 **0 条**旁白文本出现在 content 中）。
 * - `flow` 的 text 段 = 过程旁白 … 旁白 + 最终答案。
 *   ⇒ **只有最后一个 text 段承载 content**，它之前的 text 段是旁白。
 *
 * ## 因此偏移量只能是「最后一个 text 段的自身长度」
 *
 * 旧实现（三处各写一遍）用的是「所有 text 段拼接后的长度」当偏移：
 *
 * ```ts
 * const flowTextLen = flowTexts.reduce((s, n) => s + n.text.length, 0)   // ❌ 把旁白长度也计入
 * const tail = content.slice(flowTextLen)                                // ❌ 起点越过旁白总量
 * ```
 *
 * 于是 `content.slice()` 的起点比正确位置**多出「旁白总长」**，
 * 静默吃掉答案中间一整段（答案被「挖洞」），并且因为
 * `concat(flow.text).length === content.length` 是**该 bug 的恒等式**
 * （旁白总长恰等于被吃掉的洞长），长度对比永远看不出异常 ——
 * 实测 80 条中 **59 条（73.8%）** 的最后一个 text 段既不是 content 也不是它的前缀，
 * 其中 **51 条（63.8%）** 长度还完全相等。
 *
 * ⇒ **不要用长度相等当「内容正确」的判据。** 唯一判据是「最后一个 text 段是不是 content 的前缀」。
 */
import type { ChatFlowNode } from '@/types'

export type ReconcileAction =
  /** 答案为空 / 已完全一致，无需改动 */
  | 'noop'
  /** 末段是 content 前缀 → 补齐到 content（正常流式收尾） */
  | 'filled'
  /** 末段比 content 长且以 content 开头 → 裁到 content（超播） */
  | 'trimmed'
  /** 末段与 content 无前缀关系（过程旁白占位 / 数据错乱）→ 另起一个正文节点承载 content */
  | 'appended'
  /** flow 里没有任何 text 节点 → 新建 */
  | 'created'

export interface ReconcileResult {
  flow: ChatFlowNode[]
  action: ReconcileAction
  /** 改动前最后一个 text 段的长度（无则 -1），用于验证脚本断言 */
  previousLastLen: number
}

let answerSeq = 0
function defaultAnswerId(): string {
  answerSeq += 1
  return `answer-${Date.now().toString(36)}-${answerSeq}`
}

/** 该节点是否可视为「承载 content 的正文节点」：空串、content 前缀、或 content 是它的前缀 */
export function isAnswerNode(nodeText: string, answer: string): boolean {
  if (!answer) return false
  return answer.startsWith(nodeText) || nodeText.startsWith(answer)
}

function textNodesOf(flow: ChatFlowNode[]): Extract<ChatFlowNode, { kind: 'text' }>[] {
  return flow.filter((n): n is Extract<ChatFlowNode, { kind: 'text' }> => n.kind === 'text')
}

/**
 * 把 `answer`（= msg.content）收敛进 flow —— 结果文本的唯一入口。
 *
 * 纯函数语义：**不改动入参**，返回新的 flow 数组；被改动的节点是新对象（Vue 响应式友好）。
 * 幂等：对同一 (flow, answer) 反复调用，第二次起返回 `noop` 且内容不变。
 *
 * ⚠️ 流式期间**不要**调用（此时 answer 尚不完整）；只在 `done` 且打字机播完后调用，
 * 否则打字机后续 `appendText` 会把已补齐的内容再追加一遍（重复）。
 */
export function reconcileAnswerText(
  flow: ChatFlowNode[],
  answer: string,
  makeId: () => string = defaultAnswerId,
): ReconcileResult {
  const texts = textNodesOf(flow)
  const last = texts[texts.length - 1]
  const previousLastLen = last ? last.text.length : -1

  if (!answer) return { flow, action: 'noop', previousLastLen }

  if (!last) {
    return {
      flow: [...flow, { id: makeId(), kind: 'text', text: answer }],
      action: 'created',
      previousLastLen,
    }
  }

  if (last.text === answer) return { flow, action: 'noop', previousLastLen }

  if (answer.startsWith(last.text)) {
    // 正常路径：末段是答案前缀 → 补齐（这才是正确的偏移基准）
    const next = clampAnswerNode(flow, last, answer)
    return { flow: next, action: 'filled', previousLastLen }
  }

  if (last.text.startsWith(answer)) {
    // 末段超播（打字机跑到了 content 之外）→ 裁到 content
    const next = clampAnswerNode(flow, last, answer)
    return { flow: next, action: 'trimmed', previousLastLen }
  }

  // 末段是过程旁白（或数据错乱）→ **另起**正文节点，绝不覆盖旁白（不丢过程信息）
  return {
    flow: [...flow, { id: makeId(), kind: 'text', text: answer }],
    action: 'appended',
    previousLastLen,
  }
}

/** 用 answer 替换掉最后一个 text 节点（返回新数组 + 新节点对象） */
function clampAnswerNode(
  flow: ChatFlowNode[],
  target: Extract<ChatFlowNode, { kind: 'text' }>,
  answer: string,
): ChatFlowNode[] {
  return flow.map((n) => (n === target ? ({ ...n, text: answer } as ChatFlowNode) : n))
}

/**
 * 流式收尾用的**偏移量**：最后一个 text 段还应补播多少字符。
 *
 * `finish(content)` 用它重算待播文本，替代此前的 `pendingText` 缓冲 ——
 * 后者在 `done` 与打字机之间存在竞态：`syncTextToFlow` 同步跑在 `finish()` 之后，
 * 而 `finish()` 的快播是异步的，于是「已达偏移」用的是一个**还没播完**的长度。
 *
 * 返回 `null` 表示「末段不是答案节点」——调用方应先另起一个空 text 节点再从头播。
 */
export function answerTailForLastText(flow: ChatFlowNode[], answer: string): string | null {
  if (!answer) return null
  const texts = textNodesOf(flow)
  const last = texts[texts.length - 1]
  if (!last) return answer
  if (!isAnswerNode(last.text, answer)) return null
  if (!answer.startsWith(last.text)) return '' // 末段超播 → 无需再播
  return answer.slice(last.text.length)
}
