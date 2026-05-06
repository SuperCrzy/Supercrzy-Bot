import type { Context } from 'koa'
import { getDB } from '../services/database'
import { config } from '../config'
import { runAgentLoop } from './agent'

// Valid DeepSeek API model IDs
const VALID_MODELS = new Set([
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v3.2-speciale',
  'deepseek-v3.2',
  'deepseek-v3.2-exp',
  'deepseek-v3.1-terminus',
  'deepseek-chat',
  'deepseek-chat-v3-0324',
  'deepseek-chat-v2.5',
  'deepseek-reasoner',
  'deepseek-r1',
  'deepseek-r1-0528',
  'deepseek-r1-zero',
  'deepseek-r1-distill-qwen-32b',
  'deepseek-r1-distill-qwen-14b',
  'deepseek-r1-distill-llama-70b',
  'deepseek-prover-v2',
])

function resolveModel(requestModel?: string): string {
  const db = getDB()
  const model = requestModel
    || (db.prepare('SELECT value FROM settings WHERE key = ?').get('model') as any)?.value
    || config.deepseek.defaultModel

  // If model is not in our known list, fall back to default
  if (!VALID_MODELS.has(model)) {
    console.warn(`[chat] Unknown model "${model}", falling back to ${config.deepseek.defaultModel}`)
    return config.deepseek.defaultModel
  }
  return model
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
  const apiKeyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any
  const apiKey = apiKeyRow?.value || config.deepseek.apiKey

  if (!apiKey) {
    ctx.status = 400
    ctx.body = { error: 'API Key not configured. Please set it in Settings.' }
    return
  }

  // Get model and other settings
  const model = resolveModel(body.model)
  const temperature = body.temperature || parseFloat((db.prepare('SELECT value FROM settings WHERE key = ?').get('temperature') as any)?.value || '0.7')
  const systemPrompt = (db.prepare('SELECT value FROM settings WHERE key = ?').get('systemPrompt') as any)?.value || ''

  // Prepend system message if present
  const messages = [...body.messages]
  if (systemPrompt) {
    messages.unshift({ role: 'system', content: systemPrompt })
  }

  const url = `${config.deepseek.baseUrl}/v1/chat/completions`

  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: body.max_tokens || 8192,
      stream: true,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    ctx.status = response.status
    ctx.type = 'application/json'
    ctx.body = { error: `DeepSeek API error: ${errorText}` }
    return
  }

  ctx.status = 200
  ctx.respond = false

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
  const apiKeyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any
  const apiKey = apiKeyRow?.value || config.deepseek.apiKey

  if (!apiKey) {
    ctx.status = 400
    ctx.body = { error: 'API Key not configured' }
    return
  }

  const model = resolveModel(body.model)
  const systemPrompt = (db.prepare('SELECT value FROM settings WHERE key = ?').get('systemPrompt') as any)?.value || ''

  const messages = [...body.messages]
  if (systemPrompt) {
    messages.unshift({ role: 'system', content: systemPrompt })
  }

  const url = `${config.deepseek.baseUrl}/v1/chat/completions`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: body.temperature || 0.7,
      max_tokens: body.max_tokens || 8192,
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
  const body = ctx.request.body as ChatRequestBody & { agent?: boolean; maxTurns?: number }
  if (!body.messages || !Array.isArray(body.messages)) {
    ctx.status = 400
    ctx.body = { error: 'messages is required and must be an array' }
    return
  }

  const db = getDB()
  const apiKeyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any
  const apiKey = apiKeyRow?.value || config.deepseek.apiKey

  if (!apiKey) {
    ctx.status = 400
    ctx.body = { error: 'API Key not configured. Please set it in Settings.' }
    return
  }

  const model = resolveModel(body.model)
  const temperature = body.temperature || parseFloat(
    (db.prepare('SELECT value FROM settings WHERE key = ?').get('temperature') as any)?.value || '0.7'
  )
  const systemPrompt = (db.prepare('SELECT value FROM settings WHERE key = ?').get('systemPrompt') as any)?.value || ''
  const maxTurns = body.maxTurns || 10

  // Set SSE headers
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  ctx.status = 200
  ctx.respond = false

  try {
    await runAgentLoop(ctx, body.messages, {
      model,
      apiKey,
      temperature,
      maxTokens: body.max_tokens || 8192,
      systemPrompt,
      maxTurns,
    })
    ctx.res.end()
  } catch (err: any) {
    ctx.res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`)
    ctx.res.end()
  }
}
