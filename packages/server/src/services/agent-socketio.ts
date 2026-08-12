/**
 * Agent Socket.IO 服务
 * 复用 agent.ts 的 runAgentLoop，只做 Socket.IO ↔ SSE 桥接
 */
import { Server as SocketIOServer } from 'socket.io'
import { createServer as createHttpServer } from 'http'
import { getDB } from './database'
import { config } from '../config'
import { runAgentLoop } from './agent'

// 缓存系统提示词（按模型名区分）
const promptCache = new Map<string, { prompt: string; time: number }>()

function buildPrompt(userMsg: string, model: string): string {
  const now = Date.now()
  const cached = promptCache.get(model)
  if (cached && now - cached.time < 30000) return cached.prompt
  const db = getDB()
  const systemPrompt = (db.prepare('SELECT value FROM settings WHERE key = ?').get('systemPrompt') as any)?.value || ''
  const memoryEnabledRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryEnabled') as any
  const memoryEnabled = memoryEnabledRow ? memoryEnabledRow.value === 'true' : true
  const memories = memoryEnabled ? db.prepare('SELECT key, content FROM agent_memory ORDER BY importance DESC LIMIT 10').all() as any[] : []
  const memText = memories.length > 0 ? '\n## Memories\n' + memories.map((m: any) => `- ${m.key}: ${m.content}`).join('\n') : ''
  const prompt = `${systemPrompt}${memText}

## Your Setup
- Model: **${model || 'deepseek-v4-pro'}** | Platform: SuperCrzy Agent
- Workspace: ${process.env.WORKSPACE_DIR || process.cwd()}

## Core Principle
The deliverable is a working result backed by real output — not a description of one.
Do not stop at a plan or a stub. Keep going until the task is done.
If something blocks you, say so directly. Never fabricate results.

## Rules
1. Simple questions → answer directly. No tools.
2. Tasks → do them end to end. Show real output.
3. Fails → try different way immediately.
4. Stuck twice → tell the user.
5. Be concise. Show results, not process.
6. Don't narrate. Just do it.`
  promptCache.set(model, { prompt, time: now })
  return prompt
}

interface AgentConfig {
  model: string
  apiKey: string
  temperature: number
  maxTokens: number
  systemPrompt: string
  maxTurns: number
}

export function createAgentIOServer(_existingServer: any) {
  const port = parseInt(process.env.IO_PORT || '3002', 10)
  const httpServer = createHttpServer()
  const io = new SocketIOServer(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
  })

  io.on('connection', (socket) => {
    console.log(`[agent-io] Client connected: ${socket.id.slice(0, 8)}`)

    socket.on('chat', async (data: { messages: any[]; config?: Partial<AgentConfig>; sessionId?: string; model?: string }) => {
      try {
      const db = getDB()
      // 从 settings 表读取 maxTurns，请求体可覆盖
      const savedMaxTurns = (db.prepare('SELECT value FROM settings WHERE key = ?').get('maxTurns') as any)?.value
      const defaultMaxTurns = savedMaxTurns ? parseInt(savedMaxTurns) : 80
      const rawModel = data.model || data.config?.model || config.deepseek.defaultModel

      // 根据模型名解析 provider（baseUrl + apiKey）— 支持 UUID
      let apiKey = (db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any)?.value || config.deepseek.apiKey
      let baseUrl = config.deepseek.baseUrl

      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      let model = rawModel
      const customModel = UUID_RE.test(rawModel)
        ? db.prepare('SELECT cm.*, cm.model_id as real_model_id, cp.base_url, cp.api_key, cp.provider_key FROM custom_models cm JOIN custom_providers cp ON cm.provider_id = cp.id WHERE cm.id = ? AND cm.enabled = 1').get(rawModel) as any
        : db.prepare('SELECT cm.*, cm.model_id as real_model_id, cp.base_url, cp.api_key, cp.provider_key FROM custom_models cm JOIN custom_providers cp ON cm.provider_id = cp.id WHERE cm.model_id = ? AND cm.enabled = 1').get(rawModel) as any

      if (customModel) {
        baseUrl = customModel.base_url || baseUrl
        apiKey = customModel.api_key || apiKey
        model = customModel.real_model_id  // UUID → 真实 model_id
      }

      if (!apiKey) {
        socket.emit('error', { message: 'API Key not configured' })
        return
      }

      const systemPrompt = buildPrompt(data.messages[data.messages.length - 1]?.content || '', model)
      const userMessages = data.messages.map((m: any) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }))

      // 构建 mock Koa context — 把 SSE 事件桥接到 Socket.IO
      const mockCtx: any = {
        set: () => {},
        status: 200,
        respond: false,
        get res() { return mockRes },
      }
      const mockRes: any = {
        write: () => {},
        end: () => {},
        get socket() { return { setNoDelay: () => {}, setTimeout: () => {} } },
      }

      // 事件桥接：SSE → Socket.IO
      const sseToSocket: Record<string, string> = {
        thinking: 'thinking',
        thinking_chunk: 'thinking_chunk',
        content_chunk: 'content_chunk',
        content: 'content',
        tool_call: 'tool_call',
        tool_result: 'tool_result',
        tool_duration: 'tool_duration',
        file_created: 'file_created',
        delivery_summary: 'delivery_summary',
        question: 'question',
        error: 'error',
        done: 'done',
        planner_plan: 'planner_plan',
        config: 'config',
      }

      // 重写 emitSSE 的实现
      let sseBuffer = ''
      let sseEventType = 'message'
      mockCtx.res.write = (chunk: string) => {
        sseBuffer += chunk
        const lines = sseBuffer.split('\n')
        sseBuffer = lines.pop() || ''
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            sseEventType = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const dataStr = line.slice(6)
            try {
              const data = JSON.parse(dataStr)
              const socketEvent = sseToSocket[sseEventType] || sseEventType
              socket.emit(socketEvent, data)
            } catch {
              // non-JSON data, emit as-is
              socket.emit(sseEventType, { content: dataStr })
            }
          } else if (line.startsWith(': ')) {
            // heartbeat, ignore
          }
        }
      }

      try {
        await runAgentLoop(
          mockCtx as any,
          userMessages,
          {
            model,
            apiKey,
            baseUrl,
            temperature: data.config?.temperature || 0.7,
            maxTokens: data.config?.maxTokens || 16384,
            systemPrompt,
            maxTurns: data.config?.maxTurns || defaultMaxTurns,
          },
        )
      } catch (err: any) {
        console.error(`[agent-io] Error:`, err.message)
        socket.emit('error', { message: err.message })
      }
      socket.emit('done', {})
      } catch (outerErr: any) {
        console.error(`[agent-io] Unhandled error:`, outerErr.message)
        socket.emit('error', { message: outerErr.message })
        socket.emit('done', {})
      }
    })

    socket.on('disconnect', () => {
      console.log(`[agent-io] Client disconnected: ${socket.id.slice(0, 8)}`)
    })
  })

  httpServer.listen(port, () => {
    console.log(`[agent-io] Socket.IO server ready at http://localhost:${port}`)
  })
}
