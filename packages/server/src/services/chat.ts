import type { Context } from 'koa'
import { getDB } from '../services/database'
import { config } from '../config'
import { runAgentLoop } from './agent'
import { basename, join } from 'path'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { safeWriteSse, endSseStream, registerSseStream } from './sse-health'

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
  // 逐 token 转发是背压最重的路径：客户端一旦消费不动，写会开始返回 false
  registerSseStream(ctx, 'chat-stream')

  const reader = response.body?.getReader()
  if (!reader) {
    endSseStream(ctx)
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
          safeWriteSse(ctx, 'data: [DONE]\n\n')
          continue
        }
        try {
          JSON.parse(data) // validate
          safeWriteSse(ctx, `data: ${data}\n\n`)
        } catch {
          // skip
        }
      }
    }
  }

  endSseStream(ctx)
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
 * 视觉多模态：读取上传图片 → base64 data URL（2026-08-23 接入）
 * img.url 形如 /api/upload/files/xxx，磁盘文件在 <cwd>/uploads/xxx
 */
async function imageToBase64DataUrl(url: string): Promise<string | null> {
  try {
    const filename = basename(url.split('?')[0])
    if (!filename) return null
    const filePath = join(process.cwd(), 'uploads', filename)
    if (!existsSync(filePath)) return null
    const buf = await readFile(filePath)
    const mime = filename.endsWith('.png') ? 'image/png' : filename.endsWith('.gif') ? 'image/gif' : filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/**
 * 视觉注入：把图片 blocks 塞进最后一条 user 消息（content → 数组：text + image_url）
 * 图片只能在 user 消息（DeepSeek 硬约束）；返回是否有图注入成功
 */
async function injectVisionImages(messages: any[], images?: Array<{ name?: string; url?: string }>): Promise<boolean> {
  if (!images || images.length === 0) return false
  const dataUrls: string[] = []
  for (const img of images) {
    if (!img?.url) continue
    const b64 = await imageToBase64DataUrl(img.url)
    if (b64) dataUrls.push(b64)
  }
  if (dataUrls.length === 0) return false
  // 找最后一条 user 消息注入（首轮带图；历史轮次不带，符合硬约束）
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      const text = typeof messages[i].content === 'string' ? messages[i].content : ''
      messages[i].content = [
        { type: 'text', text: text || '请分析这张图片' },
        ...dataUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
      ]
      return true
    }
  }
  return false
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
  const maxTurns = body.maxTurns || (savedMaxTurns ? parseInt(savedMaxTurns) : 300)

  // 视觉多模态：有图片附件 → 注入最后一条 user 消息 blocks + 模型切 vision-exp（2026-08-23）
  const images = (body as any).images as Array<{ name?: string; url?: string }> | undefined
  const visionInjected = await injectVisionImages(body.messages, images)
  const effectiveModel = visionInjected ? 'deepseek-v4-flash-vision-exp' : model

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
  safeWriteSse(ctx, ': connected\n\n')
  // 登记活跃流：/api/health 的 sse.active 就靠这个判断"有没有长任务占着连接"
  registerSseStream(ctx, 'agent')

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
        model: effectiveModel,
        apiKey,
        baseUrl,
        temperature,
        maxTokens: body.max_tokens || 16384,
        systemPrompt,
        maxTurns,
        actor: (body as any).actor as string | undefined,  // 2026-08-29 超级协作平台：发言人标识
      },
      resumePath,
      (body as any).sessionId,  // 会话级工具授权
      (() => {  // 会话级工作目录 + 默认权限：从 sessions 表读取
        try {
          const sid = (body as any).sessionId
          if (!sid) return { workspaceDir: '', permissionLevel: 'sandbox' as const }
          const row = db.prepare('SELECT workspace_dir, permission_level FROM sessions WHERE id = ?').get(sid) as any
          const level = row?.permission_level
          return {
            workspaceDir: row?.workspace_dir || '',
            permissionLevel: ['workspace-only', 'sandbox', 'full'].includes(level) ? level : 'sandbox',
          }
        } catch { return { workspaceDir: '', permissionLevel: 'sandbox' as const } }
      })(),
      (body as any).language as string | undefined,  // 前端界面语言 → AI 回复语言跟随
    )
    endSseStream(ctx)
  } catch (err: any) {
    safeWriteSse(ctx, `event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`)
    endSseStream(ctx)
  }
}


/**
 * 多模型对比 — 所有已配置模型并行回答同一问题 + 推荐最佳（创新功能）
 * body: { messages, models?: string[] } —— models 不传则用全部已配置模型（上限 5 个）
 * 返回: { results: [{ id, model, label, content, error }], recommendation, recommendationModel }
 */
export async function handleCompareChat(ctx: Context) {
  const body = ctx.request.body as ChatRequestBody & { models?: string[]; providerConfigs?: Array<{ model: string; label?: string; baseUrl: string; apiKey: string }> }
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'messages is required' }
    return
  }
  const db = getDB()
  const systemPrompt = (db.prepare('SELECT value FROM settings WHERE key = ?').get('systemPrompt') as any)?.value || ''
  const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...body.messages] : body.messages

  // 1. 候选模型：优先用前端传入的完整配置（localStorage 是模型配置权威来源，
  //    用户刚配置的模型可能尚未同步进 custom_models 表 → 只输出默认模型的问题根因）
  const candidates: Array<{ id: string; model: string; label: string; baseUrl: string; apiKey: string }> = []
  const seen = new Set<string>()
  if (Array.isArray(body.providerConfigs)) {
    for (const pc of body.providerConfigs) {
      if (!pc.model || !pc.apiKey || seen.has(pc.model)) continue
      seen.add(pc.model)
      candidates.push({ id: 'ls-' + pc.model, model: pc.model, label: pc.label || pc.model, baseUrl: pc.baseUrl, apiKey: pc.apiKey })
    }
  }

  // 2. 补充 DB 中已配置模型（custom_models + 有 key 的 provider）
  const rows = db.prepare(`
    SELECT cm.id, cm.model_id, cm.display_name, cp.base_url, cp.api_key
    FROM custom_models cm JOIN custom_providers cp ON cm.provider_id = cp.id
    WHERE cm.enabled = 1 AND cp.enabled = 1 AND cp.api_key != ''
  `).all() as Array<{ id: string; model_id: string; display_name: string; base_url: string; api_key: string }>
  for (const r of rows) {
    if (seen.has(r.model_id)) continue
    seen.add(r.model_id)
    candidates.push({ id: r.id, model: r.model_id, label: r.display_name || r.model_id, baseUrl: r.base_url, apiKey: r.api_key })
  }

  // 3. 兜底：默认模型（settings.model / deepseek）
  const defaultModel = resolveModel(undefined)
  const defaultKey = (db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any)?.value || config.deepseek.apiKey
  if (!seen.has(defaultModel)) {
    const dp = resolveProvider(defaultModel, config.deepseek.baseUrl, defaultKey)
    candidates.push({ id: 'default', model: defaultModel, label: defaultModel, baseUrl: dp.baseUrl, apiKey: dp.apiKey })
  }

  let chosen = candidates
  if (body.models && body.models.length > 0) {
    chosen = candidates.filter((c) => body.models!.includes(c.model) || body.models!.includes(c.id))
  }
  if (chosen.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'No configured models. Add models in Models page first.' }
    return
  }
  chosen = chosen.slice(0, 5)

  // 2. 并行调用所有模型
  const call = async (c: (typeof candidates)[number]) => {
    try {
      const url = normalizeBaseUrl(c.baseUrl) + '/v1/chat/completions'
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(c.apiKey.startsWith('tp-') ? { 'api-key': c.apiKey } : { Authorization: 'Bearer ' + c.apiKey }),
        },
        body: JSON.stringify({ model: c.model, messages: msgs, temperature: 0.7, max_tokens: 4096 }),
      })
      if (!resp.ok) throw new Error('HTTP ' + resp.status)
      const data = await resp.json()
      const content = data?.choices?.[0]?.message?.content || ''
      return { id: c.id, model: c.model, label: c.label, content, error: '' }
    } catch (e: any) {
      return { id: c.id, model: c.model, label: c.label, content: '', error: e.message || 'failed' }
    }
  }
  const results = await Promise.all(chosen.map(call))

  // 3. 推荐：用第一个成功模型当评委，点评哪个回答最好
  let recommendation = ''
  let recommendationModel = ''
  const okResults = results.filter((r) => r.content && !r.error)
  if (okResults.length >= 2) {
    try {
      const first = okResults[0]
      // 评委配置从候选列表取（results 不含 baseUrl/apiKey/model）
      const judge = chosen.find((c) => c.id === first.id) || {
        id: first.id,
        model: config.deepseek.defaultModel,
        label: first.label,
        baseUrl: config.deepseek.baseUrl,
        apiKey: (db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any)?.value || config.deepseek.apiKey,
      }
      const judgePrompt = [
        { role: 'system', content: 'You are a fair judge. Compare the following answers from different AI models to the same question, pick the ONE best answer, and explain why in 2-3 sentences in the user\'s language. Always quote the model label like 【label】 when recommending.' },
        ...msgs,
        { role: 'user', content: okResults.map((r) => '【' + r.label + '】\n' + r.content).join('\n\n---\n\n') },
      ]
      const url = normalizeBaseUrl(judge.baseUrl) + '/v1/chat/completions'
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(judge.apiKey.startsWith('tp-') ? { 'api-key': judge.apiKey } : { Authorization: 'Bearer ' + judge.apiKey }),
        },
        body: JSON.stringify({ model: judge.model, messages: judgePrompt, temperature: 0.3, max_tokens: 1024 }),
      })
      if (resp.ok) {
        const data = await resp.json()
        recommendation = data?.choices?.[0]?.message?.content || ''
        recommendationModel = judge.label
      }
    } catch { /* 推荐失败不影响主结果 */ }
  }

  ctx.body = {
    results: results.map((r) => ({ id: r.id, model: r.model, label: r.label, content: r.content, error: r.error })),
    recommendation,
    recommendationModel,
  }
}


/**
 * 多模型对比 — 流式版：每个模型独立流式输出，前端多列同时打字机渲染（视觉冲击）
 * body: { messages, models?, providerConfigs? }（与 handleCompareChat 同构）
 * SSE 事件（data JSON）：
 *   {"t":"d","id":"<modelId>","text":"增量"}        模型增量文本
 *   {"t":"done","id":"<modelId>","label":"..."}     某模型完成
 *   {"t":"reco","text":"推荐内容"}                   评委推荐（完成后）
 *   {"t":"end"}                                     全部结束
 */
export async function handleCompareStreamChat(ctx: Context) {
  const body = ctx.request.body as ChatRequestBody & { models?: string[]; providerConfigs?: Array<{ model: string; label?: string; baseUrl: string; apiKey: string }> }
  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'messages is required' }
    return
  }
  const db = getDB()
  const systemPrompt = (db.prepare('SELECT value FROM settings WHERE key = ?').get('systemPrompt') as any)?.value || ''
  const msgs = systemPrompt ? [{ role: 'system', content: systemPrompt }, ...body.messages] : body.messages

  // ---- 候选模型（与 handleCompareChat 同逻辑）----
  const candidates: Array<{ id: string; model: string; label: string; baseUrl: string; apiKey: string }> = []
  const seen = new Set<string>()
  if (Array.isArray(body.providerConfigs)) {
    for (const pc of body.providerConfigs) {
      if (!pc.model || !pc.apiKey || seen.has(pc.model)) continue
      seen.add(pc.model)
      candidates.push({ id: 'ls-' + pc.model, model: pc.model, label: pc.label || pc.model, baseUrl: pc.baseUrl, apiKey: pc.apiKey })
    }
  }
  const rows = db.prepare(`
    SELECT cm.id, cm.model_id, cm.display_name, cp.base_url, cp.api_key
    FROM custom_models cm JOIN custom_providers cp ON cm.provider_id = cp.id
    WHERE cm.enabled = 1 AND cp.enabled = 1 AND cp.api_key != ''
  `).all() as Array<{ id: string; model_id: string; display_name: string; base_url: string; api_key: string }>
  for (const r of rows) {
    if (seen.has(r.model_id)) continue
    seen.add(r.model_id)
    candidates.push({ id: r.id, model: r.model_id, label: r.display_name || r.model_id, baseUrl: r.base_url, apiKey: r.api_key })
  }
  const defaultModel = resolveModel(undefined)
  const defaultKey = (db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any)?.value || config.deepseek.apiKey
  if (!seen.has(defaultModel)) {
    const dp = resolveProvider(defaultModel, config.deepseek.baseUrl, defaultKey)
    candidates.push({ id: 'default', model: defaultModel, label: defaultModel, baseUrl: dp.baseUrl, apiKey: dp.apiKey })
  }
  let chosen = candidates
  if (body.models && body.models.length > 0) {
    chosen = candidates.filter((c) => body.models!.includes(c.model) || body.models!.includes(c.id))
  }
  if (chosen.length === 0) {
    ctx.status = 400
    ctx.body = { error: 'No configured models. Add models in Models page first.' }
    return
  }
  chosen = chosen.slice(0, 5)

  // ---- SSE 流式转发 ----
  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  ctx.res.flushHeaders?.()
  registerSseStream(ctx, 'compare-stream')
  const send = (obj: unknown) => {
    safeWriteSse(ctx, `data: ${JSON.stringify(obj)}\n\n`)
  }

  // 并发请求每个模型（stream），增量转发
  const streamOne = async (c: (typeof chosen)[number]) => {
    let content = ''
    try {
      const url = normalizeBaseUrl(c.baseUrl) + '/v1/chat/completions'
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(c.apiKey.startsWith('tp-') ? { 'api-key': c.apiKey } : { Authorization: 'Bearer ' + c.apiKey }),
        },
        body: JSON.stringify({ model: c.model, messages: msgs, temperature: 0.7, max_tokens: 4096, stream: true }),
      })
      if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status)
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice(6).trim()
          if (payload === '[DONE]') continue
          try {
            const json = JSON.parse(payload)
            const delta = json?.choices?.[0]?.delta?.content || ''
            if (delta) {
              content += delta
              send({ t: 'd', id: c.id, text: delta })
            }
          } catch { /* 跳过坏 chunk */ }
        }
      }
      return { id: c.id, label: c.label, content, error: '' }
    } catch (e: any) {
      return { id: c.id, label: c.label, content, error: e.message || 'failed' }
    } finally {
      send({ t: 'done', id: c.id, label: c.label })
    }
  }

  const results = await Promise.all(chosen.map(streamOne))

  // 评委推荐（第一个成功模型，一次性返回）
  const okResults = results.filter((r) => r.content && !r.error)
  if (okResults.length >= 2) {
    try {
      const first = okResults[0]
      // 评委配置从候选列表取（results 不含 baseUrl/apiKey/model）
      const judge = chosen.find((c) => c.id === first.id) || {
        id: first.id,
        model: config.deepseek.defaultModel,
        label: first.label,
        baseUrl: config.deepseek.baseUrl,
        apiKey: (db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any)?.value || config.deepseek.apiKey,
      }
      const judgePrompt = [
        { role: 'system', content: 'You are a fair judge. Compare the following answers from different AI models to the same question, pick the ONE best answer, and explain why in 2-3 sentences in the user\'s language. Always quote the model label like 【label】 when recommending.' },
        ...msgs,
        { role: 'user', content: okResults.map((r) => '【' + r.label + '】\n' + r.content).join('\n\n---\n\n') },
      ]
      const url = normalizeBaseUrl(judge.baseUrl) + '/v1/chat/completions'
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(judge.apiKey.startsWith('tp-') ? { 'api-key': judge.apiKey } : { Authorization: 'Bearer ' + judge.apiKey }) },
        body: JSON.stringify({ model: judge.model, messages: judgePrompt, temperature: 0.3, max_tokens: 1024 }),
      })
      if (resp.ok) {
        const data = await resp.json()
        const reco = data?.choices?.[0]?.message?.content || ''
        if (reco) send({ t: 'reco', text: reco })
      }
    } catch { /* 推荐失败不影响 */ }
  }

  send({ t: 'end' })
  endSseStream(ctx)
}
