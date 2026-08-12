import type { Context } from 'koa'
import { getDB } from '../services/database'
import { config } from '../config'
import { runAgentLoop } from './agent'

/** 标准化 base URL，确保不会出现双重 /v1 */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, '')
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 解析模型名 → 真实 model_id（用于发给 API） */
function resolveModel(requestModel?: string): string {
  const db = getDB()
  const model = requestModel
    || (db.prepare('SELECT value FROM settings WHERE key = ?').get('model') as any)?.value
    || config.deepseek.defaultModel

  if (UUID_RE.test(model)) {
    const byId = db.prepare('SELECT model_id FROM custom_models WHERE id = ? AND enabled = 1').get(model) as any
    if (byId) return byId.model_id
  }

  const customModel = db.prepare(
    'SELECT model_id FROM custom_models WHERE model_id = ? AND enabled = 1'
  ).get(model) as any
  if (customModel) return model

  const DEEPSEEK_MODELS = new Set([
    'deepseek-v4-pro', 'deepseek-v4-flash',
    'deepseek-v3.2-speciale', 'deepseek-v3.2', 'deepseek-v3.2-exp',
    'deepseek-v3.1-terminus', 'deepseek-chat', 'deepseek-chat-v3-0324',
    'deepseek-chat-v2.5', 'deepseek-reasoner', 'deepseek-r1',
    'deepseek-r1-0528', 'deepseek-r1-zero',
    'deepseek-r1-distill-qwen-32b', 'deepseek-r1-distill-qwen-14b',
    'deepseek-r1-distill-llama-70b', 'deepseek-prover-v2',
  ])
  if (DEEPSEEK_MODELS.has(model)) return model

  console.warn(`[chat] Unknown model "${model}", passing through to API`)
  return model
}

/** 根据原始请求（UUID 或 model_id）解析 provider 的 baseUrl + apiKey */
function resolveProvider(requestModel: string, fallbackBaseUrl: string, fallbackApiKey: string): { baseUrl: string; apiKey: string } {
  const db = getDB()
  let baseUrl = fallbackBaseUrl
  let apiKey = fallbackApiKey

  const customModel = UUID_RE.test(requestModel)
    ? db.prepare('SELECT cm.*, cp.base_url, cp.api_key FROM custom_models cm JOIN custom_providers cp ON cm.provider_id = cp.id WHERE cm.id = ? AND cm.enabled = 1').get(requestModel) as any
    : db.prepare('SELECT cm.*, cp.base_url, cp.api_key FROM custom_models cm JOIN custom_providers cp ON cm.provider_id = cp.id WHERE cm.model_id = ? AND cm.enabled = 1').get(requestModel) as any

  if (customModel) {
    baseUrl = customModel.base_url || baseUrl
    apiKey = customModel.api_key || apiKey
  }

  return { baseUrl, apiKey }
}

interface ChatRequestBody {
  messages: Array<{ role: string; content: string }>
  model?: string
  temperature?: number
  max_tokens?: number
  stream?: boolean
}

export async function handleStreamChat(ctx: Context) {
  const body = ctx.request.body as ChatRequestBody
  if (!body.messages || !Array.isArray(body.messages)) {
    ctx.status = 400
    ctx.body = { error: 'messages is required and must be an array' }
    return
  }

  // Get API key from settings table or config
  const db = getDB()
  let apiKey = (db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any)?.value || config.deepseek.apiKey
  let baseUrl = config.deepseek.baseUrl

  if (!apiKey) {
    ctx.status = 400
    ctx.body = { error: 'API Key not configured. Please set it in Settings.' }
    return
  }

  // Get model and other settings
  const model = resolveModel(body.model)

  // 用原始请求（可能含 UUID）解析 provider
  const provider = resolveProvider(body.model || model, baseUrl, apiKey)
  baseUrl = provider.baseUrl
  apiKey = provider.apiKey

  const temperature = body.temperature || parseFloat((db.prepare('SELECT value FROM settings WHERE key = ?').get('temperature') as any)?.value || '0.7')
  const systemPrompt = (db.prepare('SELECT value FROM settings WHERE key = ?').get('systemPrompt') as any)?.value || ''

  // Prepend system message if present
  const messages = [...body.messages]
  if (systemPrompt) {
    messages.unshift({ role: 'system', content: systemPrompt })
  }

  const url = `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey.startsWith('tp-')
        ? { 'api-key': apiKey }
        : { Authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: body.max_tokens || 16384,
      stream: true,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    ctx.status = response.status
    ctx.type = 'application/json'
    ctx.body = { error: `API error: ${errorText}` }
    return
  }

  ctx.status = 200
  ctx.respond = false

  const res = ctx.res
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const sock = (res as any).socket
  if (sock) { sock.setNoDelay(true); sock.setTimeout(0) }

  const reader = response.body?.getReader()
  if (!reader) {
    ctx.res.end()
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim()
        if (data === '[DONE]') {
          ctx.res.write('data: [DONE]\n\n')
          continue
        }
        try {
          JSON.parse(data) // validate
          ctx.res.write(`data: ${data}\n\n`)
        } catch {
          // skip
        }
      }
    }
  }

  ctx.res.end()
}

export async function handleChat(ctx: Context) {
  const body = ctx.request.body as ChatRequestBody
  if (!body.messages || !Array.isArray(body.messages)) {
    ctx.status = 400
    ctx.body = { error: 'messages is required and must be an array' }
    return
  }

  const db = getDB()
  let apiKey = (db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any)?.value || config.deepseek.apiKey
  let baseUrl = config.deepseek.baseUrl

  if (!apiKey) {
    ctx.status = 400
    ctx.body = { error: 'API Key not configured' }
    return
  }

  const model = resolveModel(body.model)

  // 用原始请求（可能含 UUID）解析 provider
  const provider2 = resolveProvider(body.model || model, baseUrl, apiKey)
  baseUrl = provider2.baseUrl
  apiKey = provider2.apiKey

  const systemPrompt = (db.prepare('SELECT value FROM settings WHERE key = ?').get('systemPrompt') as any)?.value || ''

  const messages = [...body.messages]
  if (systemPrompt) {
    messages.unshift({ role: 'system', content: systemPrompt })
  }

  const url = `${normalizeBaseUrl(baseUrl)}/v1/chat/completions`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey.startsWith('tp-')
        ? { 'api-key': apiKey }
        : { Authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: body.temperature || 0.7,
      max_tokens: body.max_tokens || 16384,
    }),
  })

  const data = await response.json()
  ctx.body = data
}

/**
 * Agent 模式 — 完整的智能体循环
 * 支持工具调用、记忆注入、多轮思考
 */
export async function handleAgentChat(ctx: Context) {
  const { readdir } = await import('fs/promises'); const { access } = await import('fs/promises');
  const fileExists = async (p: string) => { try { await access(p); return true; } catch { return false; } };
  const body = ctx.request.body as ChatRequestBody & { agent?: boolean; maxTurns?: number; resumeCheckpoint?: string }
  if (!body.messages || !Array.isArray(body.messages)) {
    ctx.status = 400
    ctx.body = { error: 'messages is required and must be an array' }
    return
  }

  const db = getDB()
  const apiKeyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any
  let apiKey = apiKeyRow?.value || config.deepseek.apiKey
  let baseUrl = config.deepseek.baseUrl

  const model = resolveModel(body.model)

  // 用原始请求（可能含 UUID）解析 provider
  const provider3 = resolveProvider(body.model || model, baseUrl, apiKey)
  baseUrl = provider3.baseUrl
  apiKey = provider3.apiKey

  const temperature = body.temperature || parseFloat(
    (db.prepare('SELECT value FROM settings WHERE key = ?').get('temperature') as any)?.value || '0.7'
  )
  const systemPrompt = (db.prepare('SELECT value FROM settings WHERE key = ?').get('systemPrompt') as any)?.value || ''
  const savedMaxTurns = (db.prepare('SELECT value FROM settings WHERE key = ?').get('maxTurns') as any)?.value
  const maxTurns = body.maxTurns || (savedMaxTurns ? parseInt(savedMaxTurns) : 80)

  // 用 Koa 标准 SSE 头 + 原生 write 写数据
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  ctx.status = 200
  ctx.respond = false

  // 禁用 TCP 缓冲 — 在 write 之前设置
  const sock = (ctx.res as any).socket
  if (sock) { sock.setNoDelay(true); sock.setTimeout(0) }

  // 发送初始注释心跳，让浏览器立即收到 headers
  ctx.res.write(': connected\n\n')

  try {
    // 兼容两种 resumeCheckpoint 语义：checkpoint id 或完整文件路径
    let resumePath = body.resumeCheckpoint
    if (resumePath && !resumePath.includes('/') && !resumePath.endsWith('.json')) {
      const { join } = await import('path')
      resumePath = join(process.cwd(), 'data', 'checkpoints', `${resumePath}.json`)
    }

    await runAgentLoop(
      ctx,
      body.messages,
      {
        model,
        apiKey,
        baseUrl,
        temperature,
        maxTokens: body.max_tokens || 16384,
        systemPrompt,
        maxTurns,
      },
      resumePath,
    )
    ctx.res.end()
  } catch (err: any) {
    ctx.res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`)
    ctx.res.end()
  }
}
