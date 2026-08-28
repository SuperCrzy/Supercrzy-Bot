import http from 'http'
import https from 'https'

/**
 * 统一模型网关（seam）：把"发 LLM 请求"这一层收拢到一个模块，agent.ts 各处复用。
 * 未来换模型后端/网关只改这里，无需碰主循环。
 * - requestChat(): 底层发请求拿 Response（供主循环流式使用，流式解析仍留在调用方）
 * - chatCompletion(): 非流式，直接返回 content（供 plan / 画图 / 复盘等简单调用）
 */
const agentCache = new Map<string, any>()

function keepAliveAgent(base: string): any {
  if (!agentCache.has(base)) {
    const Ctor = base.startsWith('https') ? https.Agent : http.Agent
    agentCache.set(base, new Ctor({ keepAlive: true, keepAliveMsecs: 2000, maxSockets: 32 }))
  }
  return agentCache.get(base)
}

/** 标准化 base URL，确保不会出现双重 /v1 */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, '')
}

function buildAuthHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(apiKey.startsWith('tp-') ? { 'api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }),
  }
}

export interface RequestChatOpts {
  baseUrl: string
  apiKey: string
  body: string
  signal?: AbortSignal
}

/** 底层发一次对话请求，返回未解析的 Response（流式/非流式皆可）。失败抛错（含 HTTP 状态与响应体）。 */
export async function requestChat(o: RequestChatOpts): Promise<Response> {
  const url = `${normalizeBaseUrl(o.baseUrl)}/v1/chat/completions`
  const res = await fetch(url, {
    method: 'POST',
    headers: buildAuthHeaders(o.apiKey),
    agent: keepAliveAgent(o.baseUrl),
    signal: o.signal,
    body: o.body,
  } as any)
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw buildApiError(res.status, errText, 'API error')
  }
  return res
}

/**
 * 构造带 HTTP 状态码与响应体的 API 错误。
 * 2026-08-28 系统性修复：此前只 `throw new Error('API error 402: ...')`，status 信息丢失，
 * classifyApiError 的 status 分支（429/401/403/413/5xx/402）全部失效，402 余额不足落入 unknown
 * → 盲重试 3 次必败 → 用户只看到"连续 4 次 API 失败 (unknown)"，长任务反复中断。
 * 现在统一挂上 status/body，让分类器能对症下药。
 */
export function buildApiError(status: number, errText: string, prefix = 'API error'): Error & { status: number; body: string } {
  const err = new Error(`${prefix} ${status}: ${errText}`) as Error & { status: number; body: string }
  err.status = status
  err.body = errText
  return err
}

export interface ChatCompletionOpts {
  baseUrl: string
  apiKey: string
  model: string
  messages: Array<{ role: string; content: any }>
  temperature?: number
  maxTokens?: number
}

/** 非流式对话，返回 choices[0].message.content（无内容返回 null）。 */
export async function chatCompletion(o: ChatCompletionOpts): Promise<string | null> {
  try {
    const body = JSON.stringify({
      model: o.model,
      messages: o.messages,
      temperature: o.temperature ?? 0.3,
      ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
    })
    const res = await requestChat({ baseUrl: o.baseUrl, apiKey: o.apiKey, body })
    const data = await res.json() as any
    return data.choices?.[0]?.message?.content || null
  } catch {
    return null
  }
}
