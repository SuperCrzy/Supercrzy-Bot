/**
 * API 错误分类器
 * 将 API 错误分类为不同原因，每种原因对应不同的恢复策略
 */

export type FailoverReason =
  | 'rate_limit'        // 429 Too Many Requests
  | 'billing'           // 账户欠费/额度用完
  | 'auth'              // 401/403 认证失败
  | 'context_overflow'  // 上下文超长 (413/context-length)
  | 'server_error'      // 500/502/503 服务端错误
  | 'timeout'           // 请求超时
  | 'connection'        // 网络连接失败
  | 'tool_sequence'     // 工具调用/思考内容消息序列违反协议（assistant.tool_calls 无配对 / reasoning_content 未原样传回）
  | 'unknown'           // 未知错误

export interface ClassifiedError {
  reason: FailoverReason
  retryable: boolean
  shouldFallback: boolean
  shouldCompress: boolean
  shouldRotateCredential: boolean
  message: string
}

const BILLING_PATTERNS = [
  /arrearage/i,
  /insufficient.*quota/i,
  /quota.*exceeded/i,
  /billing/i,
  /payment.*required/i,
  /balance.*insufficient/i,
  /free.*tier.*exceeded/i,
  /AllocationQuota\.FreeTierOnly/i,
  /exceed.*limit/i,
]

const AUTH_PATTERNS = [
  /invalid.*api.*key/i,
  /unauthorized/i,
  /authentication/i,
  /invalid.*token/i,
  /token.*expired/i,
  /access.*denied(?!.*arrearage)/i,
]

const CONTEXT_PATTERNS = [
  /context.*length/i,
  /maximum.*context/i,
  /too.*many.*tokens/i,
  /token.*limit.*exceeded/i,
  /request.*too.*large/i,
  /max.*context/i,
]

const RATE_LIMIT_PATTERNS = [
  /rate.*limit/i,
  /too.*many.*requests/i,
  /throttl/i,
  /concurrent.*request/i,
  /tpm.*limit/i,
]

// 工具调用/思考内容消息序列违反协议（2026-08-28 加，需清洗 messages 而非压缩/直接放弃）：
// - assistant.tool_calls 必须被对应 tool 消息逐个响应（"insufficient tool messages following tool_calls"）
// - 深度思考模式下 assistant 的 reasoning_content 必须原样传回（"must be passed back"）
const TOOL_SEQUENCE_PATTERNS = [
  /tool_calls.*must be followed by tool messages/i,
  /insufficient tool messages/i,
  /following tool_calls message/i,
  /responding to each tool_call_id/i,
  /reasoning_content.*must be passed back/i,
  /thinking mode.*must be passed back/i,
  /both.*tool_use.*and.*text.*block/i,
  /expected.*role.{0,5}tool/i,
]

/**
 * 分类 API 错误，返回恢复策略
 */
export function classifyApiError(err: any): ClassifiedError {
  const message = err?.message || String(err)
  const status = err?.status || err?.statusCode || err?.response?.status || 0
  const body = err?.response?.body || err?.body || ''

  // 1. HTTP 状态码优先
  if (status === 429) {
    return {
      reason: 'rate_limit',
      retryable: true,
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: true,
      message,
    }
  }

  if (status === 401 || status === 403) {
    // 区分 auth 和 billing
    if (BILLING_PATTERNS.some(p => p.test(message) || p.test(body))) {
      return {
        reason: 'billing',
        retryable: false,
        shouldFallback: true,
        shouldCompress: false,
        shouldRotateCredential: false,
        message,
      }
    }
    return {
      reason: 'auth',
      retryable: false,
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: true,
      message,
    }
  }

  if (status === 413) {
    return {
      reason: 'context_overflow',
      retryable: true,
      shouldFallback: false,
      shouldCompress: true,
      shouldRotateCredential: false,
      message,
    }
  }

  if (status >= 500 && status < 600) {
    return {
      reason: 'server_error',
      retryable: true,
      shouldFallback: status === 502 || status === 503,
      shouldCompress: false,
      shouldRotateCredential: false,
      message,
    }
  }

  // 2. 消息模式匹配
  if (BILLING_PATTERNS.some(p => p.test(message) || p.test(body))) {
    return {
      reason: 'billing',
      retryable: false,
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: false,
      message,
    }
  }

  if (CONTEXT_PATTERNS.some(p => p.test(message) || p.test(body))) {
    return {
      reason: 'context_overflow',
      retryable: true,
      shouldFallback: false,
      shouldCompress: true,
      shouldRotateCredential: false,
      message,
    }
  }

  if (RATE_LIMIT_PATTERNS.some(p => p.test(message) || p.test(body))) {
    return {
      reason: 'rate_limit',
      retryable: true,
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: true,
      message,
    }
  }

  if (AUTH_PATTERNS.some(p => p.test(message) || p.test(body))) {
    return {
      reason: 'auth',
      retryable: false,
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: true,
      message,
    }
  }

  // 3. 网络/超时错误
  if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND') || message.includes('fetch failed')) {
    return {
      reason: 'connection',
      retryable: true,
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: false,
      message,
    }
  }

  if (message.includes('timeout') || message.includes('ETIMEDOUT') || message.includes('abort')) {
    return {
      reason: 'timeout',
      retryable: true,
      shouldFallback: false,
      shouldCompress: false,
      shouldRotateCredential: false,
      message,
    }
  }

  // 工具调用/思考内容消息序列违反协议（2026-08-28 加：之前落入 unknown，重试用坏序列必败 3 次中断。
  // 现识别为 tool_sequence，由 agent 在重试前先清洗 messages——对症修复而非盲目压缩/放弃）
  if (TOOL_SEQUENCE_PATTERNS.some(p => p.test(message) || p.test(body))) {
    return {
      reason: 'tool_sequence',
      retryable: true,
      shouldFallback: false,
      shouldCompress: false,
      shouldRotateCredential: false,
      message,
    }
  }

  // 4. 未知错误 — 默认可重试
  return {
    reason: 'unknown',
    retryable: true,
    shouldFallback: false,
    shouldCompress: false,
    shouldRotateCredential: false,
    message,
  }
}

/**
 * 计算退避延迟（带抖动，防雷群效应）
 */
export function jitteredBackoff(attempt: number, baseDelay = 1000, maxDelay = 15000): number {
  const exponent = Math.min(attempt - 1, 6)
  const delay = Math.min(baseDelay * Math.pow(2, exponent), maxDelay)
  const jitter = Math.random() * 0.5 * delay
  return Math.round(delay + jitter)
}
