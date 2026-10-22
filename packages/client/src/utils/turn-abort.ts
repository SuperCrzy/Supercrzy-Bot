/**
 * 用户点"停止"时把取消事实落到消息上（2026-10-22，问题 A3 / 原 P0-6）
 *
 * 为什么必须落成**消息级**事实：
 *   `ElapsedBadge` 只以"有没有时长"判状态时，停止后 running=false 且 elapsedMs 空
 *   ⇒ 徽标**整块消失**；刷新后 `stores/chat.ts` 又用工具 createTime 反算出 elapsedMs
 *   ⇒ 被中断的那轮被显示成「已完成 Xs」（把没跑完说成跑完了）。
 *   取消是第三态，只能由消息自己记住，不能靠"有没有时长"反推。
 *
 * 从 ChatView 下沉的两个原因：① 巨石闸门（ChatView ≤5500 行）；② 这两步的边界条件
 * （"最后一条 assistant"、"只在有在跑工具时才算 touched"）纯靠真机点停止才能验，抽出来可断言。
 */

import type { ChatMessage } from '@/types'

/** 视为"在跑"的工具状态（其余状态不因停止而改写） */
const IN_FLIGHT = ['running', 'stream_executing', 'pending', 'approved']

/**
 * 同一次调用同时做两件事（顺序无关，但都不做的话 UI 会有残留）：
 *   1. 把**最后一条** assistant 消息标记 `isAborted`，并冻结已产生的耗时；
 *   2. 把该轮仍在跑的工具节点置 `cancelled`（对齐主流实现 ToolState.cancelled）。
 *
 * 注意 1 与 2 各自独立找位置：一条**纯文本**中断的消息没有 flow（或没有在跑的工具），
 * 但它同样要显示"已取消"；反过来，历史消息里可能存在没有 flow 的 assistant 行。
 */
export function markTurnAborted(msgs: ChatMessage[], now: number = Date.now()): void {
  // 1) 消息级取消事实
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== 'assistant') continue
    const m = msgs[i]
    // 有起点就冻结一个精确值：取消态不跑秒针，没有定格值会退化成"当前时刻 − 起点"
    if (m.startedAt && !m.elapsedMs) m.elapsedMs = Math.max(0, now - m.startedAt)
    m.isAborted = true
    break
  }
  // 2) 在跑的工具置 cancelled（从末尾找第一条有在跑工具的 assistant 消息）
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'assistant' || !m.flow) continue
    let touched = false
    for (const n of m.flow) {
      if (n.kind === 'tool' && IN_FLIGHT.includes(n.tool.status)) {
        n.tool.status = 'cancelled'
        touched = true
      }
    }
    if (touched) break
  }
}
