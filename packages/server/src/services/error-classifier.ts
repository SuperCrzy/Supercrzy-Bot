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
  // 2026-08-28 补：DeepSeek 原文是 "Insufficient Balance"（Insufficient 在前），
  // 原有的 /balance.*insufficient/i 顺序反了，永远匹配不上 → 402 落入 unknown 盲重试 3 次。
  /insufficient.*balance/i,
  /insufficient.*credit/i,
  /out of.*balance/i,
  /余额不足/i,
  /免费额度.*用尽/i,
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
 * 从错误中提取 HTTP 状态码。
 * 2026-08-28 加：历史上多处 throw 只拼了消息文本（"API error 402: ..."），没挂 status 字段，
 * 导致按 status 分类的分支全是死代码。这里做消息文本兜底解析，即使上游没挂 status 也能正确分类。
 */
export function extractStatus(err: any, message: string): number {
  const direct = err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.code
  if (typeof direct === 'number' && direct >= 100 && direct < 600) return direct
  // 文本兜底（锚定关键词，避免把正文里的普通数字误判成状态码）：
  // "API error 402:" / "HTTP 402" / "status code 402" / "错误码 402"
  const m = message.match(/(?:error|code|status|HTTP|错误码|状态码)[\s:：]*?(\d{3})\b/i)
  if (m) {
    const n = parseInt(m[1], 10)
    if (n >= 400 && n < 600) return n
  }
  return 0
}

/** 幂等/瞬态的 4xx —— 这些重试有意义，其他 4xx 重试无意义（同样的请求永远同样的错） */
const RETRYABLE_4XX = new Set([408, 409, 425, 429])

/**
 * 分类 API 错误，返回恢复策略
 */
export function classifyApiError(err: any): ClassifiedError {
  const message = err?.message || String(err)
  const status = extractStatus(err, message)
  const body = err?.response?.body || err?.body || ''

  // 1. HTTP 状态码优先
  if (status === 402) {
    // 2026-08-28 加：402 Payment Required（余额不足/额度用尽）。
    // 之前无此分支 → 落入 unknown → 可重试 → 盲重试 3 次必败 → 长任务反复"unknown (3/3)"中断。
    // 余额是账户级问题，重试和换模型都救不了，必须直接告诉用户去充值。
    return {
      reason: 'billing',
      retryable: false,
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: false,
      message,
    }
  }

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

  // 4. 兜底：其他 4xx 客户端错误 —— 同样的请求重试一万次还是同样的错。
  // 2026-08-28 加：此前这类错误默认 retryable:true，盲重试 3 次（400/404/422…）白白拖长失败时间，
  // 用户只看到"连续 4 次 API 失败 (unknown)"。除幂等/瞬态的 408/409/425/429 外一律不重试。
  if (status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)) {
    return {
      reason: 'unknown',
      retryable: false,
      shouldFallback: true,
      shouldCompress: false,
      shouldRotateCredential: false,
      message: `[HTTP ${status}] ${message}`.slice(0, 400),
    }
  }

  // 5. 未知错误 — 默认可重试（网络抖动/服务端瞬时问题走这里）
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
