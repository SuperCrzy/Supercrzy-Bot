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
    throw new Error(`API error ${res.status}: ${errText}`)
  }
  return res
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
