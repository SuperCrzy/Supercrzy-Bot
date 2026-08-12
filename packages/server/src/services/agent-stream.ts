import type { Context } from 'koa'
import { getDB } from '../services/database'
import { config } from '../config'

/**
 * 简化 Agent 流式端点
 * - 直接流式转发 DeepSeek 原始 token（打字机效果）
 * - 同时发送 thinking/tool_call 等事件
 * - 纯 GET + SSE，兼容 EventSource
 */
export async function handleAgentStream(ctx: Context) {
  const db = getDB()
  const apiKey = (db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any)?.value || config.deepseek.apiKey
  const systemPrompt = (db.prepare('SELECT value FROM settings WHERE key = ?').get('systemPrompt') as any)?.value || ''

  if (!apiKey) { ctx.status = 400; ctx.body = { error: 'API Key not configured' }; return }

  const msg = ctx.query.msg as string || ''
  const model = ctx.query.model as string || config.deepseek.defaultModel

  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  ctx.status = 200
  ctx.respond = false  // 手动控制响应，不让 Koa 写 body
  ctx.respond = false

  const sock = (ctx.res as any).socket; if (sock) sock.setNoDelay(true)

  async function emit(e: string, d: any) {
    ctx.res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
    await new Promise(r => setImmediate(r))  // 让出事件循环，确保客户端收到
  }

  await emit('thinking', { turn: 1, message: '开始思考...' })

  // 加载记忆
  const memories = db.prepare('SELECT key, content FROM agent_memory ORDER BY importance DESC LIMIT 10').all() as any[]
  const memText = memories.length > 0 ? '\n## Memories\n' + memories.map((m: any) => `- ${m.key}: ${m.content}`).join('\n') : ''

  const response = await fetch(`${config.deepseek.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: `${systemPrompt}${memText}\n\nUse tools when needed. Be concise.` },
        { role: 'user', content: msg },
      ],
      temperature: 0.7, max_tokens: 8192, stream: true,
      tools: [
        { type: 'function', function: { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
        { type: 'function', function: { name: 'file_read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
        { type: 'function', function: { name: 'file_write', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
      ],
      tool_choice: 'auto',
    }),
  })

  if (!response.ok) {
    await emit('error', { message: `API ${response.status}: ${await response.text()}` })
    ctx.res.end(); return
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buf = '', contentBuf = '', reasoningBuf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const d = line.slice(6).trim()
      if (d === '[DONE]') continue
      try {
        const chunk = JSON.parse(d)
        const delta = chunk.choices?.[0]?.delta
        if (delta?.reasoning_content) {
          reasoningBuf += delta.reasoning_content
          await emit('thinking_chunk', { text: delta.reasoning_content })
        }
        if (delta?.content) {
          // 直接转发原始 token — 保持 DeepSeek 的原生打字机节奏
          ctx.res.write(`data: ${JSON.stringify({ text: delta.content })}\n\n`)
        }
      } catch {}
    }
  }

  await emit('done', {})
  ctx.res.end()
}
