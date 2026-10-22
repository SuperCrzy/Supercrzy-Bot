/**
 * API 错误 → 界面呈现的判定（纯函数，2026-10-22 问题 A1）
 *
 * 背景（为什么不是"随手写两行"）：
 *   `msg.content` 是对外唯一真相（复制/导出/搜索/重载对账都读它）。历史实现把
 *   `humanizeApiError()` 的结果通过 `content` 事件写进 `msg.content`，会把本轮
 *   已产出的答案整体替换成错误文案（永久数据丢失）。
 *   现在后端把提示放进 `error` 事件的 `hint` 字段，这里决定三件事：
 *     ① 有正文 → 只挂 stopReason 横幅，正文一个字都不动；
 *     ② 无正文 → 允许写 `❌ 短消息`（没有答案可丢），同时挂 hint 供排查；
 *     ③ hint 缺失 → 退回后端 message，再退回默认文案。
 *
 * 抽成纯函数的原因：这四个分支的正确性只由输入决定，写在 ChatView 的 SSE switch 里
 * 无法单测（只能真机等 402/断网），正是这类"等不到现场"的缺陷反复复发的土壤。
 */

export interface ErrorDisplayInput {
  /** 本轮是否已经产出正文（`lastAnswerText(flow)` 非空） */
  hadText: boolean
  /** 后端下发的可执行提示（多行 markdown 风格，进横幅展示） */
  hint?: unknown
  /** 后端下发的短错误描述（`[billing] ...`） */
  message?: unknown
  /** 默认横幅文案（i18n），hint 与 message 都缺时使用 */
  fallback?: string
  /** 分类器给出的 reason，横幅配色/续跑按钮会读它 */
  reason?: unknown
}

export interface ErrorDisplay {
  /** 需要写入 `msg.content` 的文本；`undefined` = 不要动正文 */
  content?: string
  /** 需要挂到 `msg.stopReason` 的横幅 */
  stopReason?: { reason: string; message: string }
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function resolveErrorDisplay(input: ErrorDisplayInput): ErrorDisplay {
  const hint = str(input.hint)
  const msg = str(input.message)
  const reason = str(input.reason) || 'error'
  const banner = hint || msg || str(input.fallback)

  if (input.hadText) {
    // 有正文：只挂横幅，正文交给调用方按 flow 末段回填（对账不变量）
    return { stopReason: { reason, message: banner } }
  }
  // 无正文：写一条短的 ❌（不把多行 hint 塞进 content——它属于横幅，不属于答案）
  return {
    content: `❌ ${msg || banner || '请求失败'}`,
    ...(hint ? { stopReason: { reason, message: hint } } : {}),
  }
}
