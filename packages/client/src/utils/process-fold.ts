/**
 * 过程折叠的自适应规则（"不要固定模式"）。
 *
 * 两件事分开判断：
 *   1. **该不该折叠** —— 看这一轮实际做了多少步。短任务（≤ 阈值）不折叠、平铺展示，
 *      否则"执行了 3 步"会被收成一条摘要条，用户看起来像什么都没干（证据消失）。
 *   2. **折叠条放哪** —— 放在过程**第一次出现的位置**（时间顺序），不再顶到消息最上面。
 *      2026-08-25 的定稿是"整体折叠、不要多个重复折叠条"，本条只改位置，不改条数。
 *
 * 抽成纯函数是为了能被断言：阈值改动会直接影响"短任务是否可见"，这是产品规则不是样式。
 */

/** 过程步数 ≤ 此值时不折叠（短任务要让用户看见做过什么） */
export const INLINE_PROCESS_MAX_STEPS = 3

/** 长内容兜底：步数虽少但过程节点极多（思考刷屏）时仍然折叠 */
export const INLINE_PROCESS_MAX_NODES = 8

/**
 * 是否把过程折叠成摘要条。
 *
 * @param steps 这一轮的工具调用次数
 * @param nodes 过程节点总数（思考 + 工具）
 */
export function shouldFoldProcess(steps: number, nodes: number): boolean {
  if (steps <= 0) return false          // 纯聊天，没有过程可折
  if (nodes > INLINE_PROCESS_MAX_NODES) return true
  return steps > INLINE_PROCESS_MAX_STEPS
}
