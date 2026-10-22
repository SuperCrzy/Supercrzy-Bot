/**
 * Token 用量口径（2026-10-22）
 *
 * 两类数据混在一起是长期缺陷：模型 usage 返回的是真值，模型没返回时前端按
 * 「字符 × 0.6」推算。二者在 UI 上长得一模一样，落库后也无法区分，导致统计把
 * 估算当真实用量汇报。
 *
 * 规则（写成不变量，改动前先看测试）：
 * 1. 真值优先：已有 tokenCount 时，估算**永不覆盖**。
 * 2. 估算必须带标记：写估算值必定同时置 tokenEstimated = true。
 * 3. 真值必须清标记：usage 到达时置 tokenEstimated = false。
 */

/** 中英混合的粗估系数（token / 字符） */
export const TOKENS_PER_CHAR = 0.6

export interface TokenCarrier {
  content?: unknown
  tokenCount?: number
  tokenEstimated?: boolean
}

/** 字符数 → 估算 token 数 */
export function estimateTokens(charCount: number): number {
  if (!Number.isFinite(charCount) || charCount <= 0) return 0
  return Math.ceil(charCount * TOKENS_PER_CHAR)
}

/**
 * 兜底写入估算值（仅在无真值时）。返回是否真的写了。
 * 调用方传入的是**已经取好的字符数**，避免这里再依赖 content 的形状。
 */
export function fillEstimatedTokens(msg: TokenCarrier, charCount: number): boolean {
  if (msg.tokenCount && msg.tokenCount > 0) return false
  const tokens = estimateTokens(charCount)
  if (!tokens) return false
  msg.tokenCount = tokens
  msg.tokenEstimated = true
  return true
}

/** 写入模型返回的真实 usage，并清掉估算标记。返回是否真的写了。 */
export function fillMeasuredTokens(msg: TokenCarrier, totalTokens?: number): boolean {
  if (!totalTokens || totalTokens <= 0) return false
  msg.tokenCount = totalTokens
  msg.tokenEstimated = false
  return true
}

/** UI 展示：估算值加 ~ 前缀，真值原样 */
export function formatTokenCount(msg: TokenCarrier): string {
  const n = msg.tokenCount || 0
  if (!n) return ''
  return `${msg.tokenEstimated ? '~' : ''}${n}`
}
