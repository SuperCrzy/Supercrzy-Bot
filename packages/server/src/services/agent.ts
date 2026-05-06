/**
 * Agent Loop 核心逻辑
 * 实现智能体的自主决策循环：思考 → 行动 → 观察 → 思考 ...
 */
import { randomUUID } from 'crypto'
import type { Context } from 'koa'
import { config } from '../config'
import { getDB } from '../services/database'
import { toolDefinitions, executeToolCalls, type ToolCall, type ToolResult } from './tools'

interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: ToolCall[]
  tool_call_id?: string
  reasoning_content?: string  // DeepSeek thinking 模式必须回传
}

interface AgentConfig {
  model: string
  apiKey: string
  temperature: number
  maxTokens: number
  systemPrompt: string
  maxTurns: number
}

/**
 * 发送 SSE 事件给前端
 */
function emitSSE(ctx: Context, event: string, data: any) {
  ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * 从数据库加载相关记忆并构建系统提示
 */
function buildSystemPrompt(basePrompt: string, userMessage: string): string {
  const db = getDB()

  // 加载所有记忆
  const memories = db.prepare(
    'SELECT key, content, category, importance FROM agent_memory ORDER BY importance DESC LIMIT 20'
  ).all() as any[]

  let memorySection = ''
  if (memories.length > 0) {
    memorySection = '\n\n## 已存储的记忆\n' +
      memories.map((m: any) => `- [${m.key}] (${m.category}, 重要性:${m.importance}) ${m.content}`).join('\n') +
      '\n\n请利用这些记忆来个性化你的回复。使用 memory_store 工具来存储新学到的重要信息。'
  }

  // 搜索与当前消息相关的记忆
  const relatedMemories = db.prepare(
    `SELECT key, content, importance FROM agent_memory
     WHERE content LIKE ? LIMIT 5`
  ).all(`%${userMessage.slice(0, 50)}%`) as any[]

  let relatedSection = ''
  if (relatedMemories.length > 0 && memories.length > 5) {
    relatedSection = '\n\n## 相关记忆\n' +
      relatedMemories.map((m: any) => `- [${m.key}] ${m.content}`).join('\n')
  }

  const toolsSection = `\n\n## 可用工具\n你可以使用以下工具来完成任务。当需要时自动调用它们，不要询问用户是否可以使用。\n- memory_store: 存储重要的用户信息到长期记忆\n- memory_recall: 搜索已存储的记忆\n- memory_list: 列出所有记忆\n- web_search: 搜索互联网获取最新信息\n- web_fetch: 获取网页内容\n- file_read/file_write/file_exists: 读写本地文件\n- shell_exec: 执行Shell命令`

  // 匹配激活的技能
  let skillSection = ''
  try {
    const matchedSkills = db.prepare(
      `SELECT name, description, prompt_template, tools FROM skills WHERE enabled = 1`
    ).all() as any[]

    const relevantSkills = matchedSkills.filter((s: any) => {
      if (!s.trigger_keywords) return false
      const keywords = s.trigger_keywords.split(',').map((k: string) => k.trim().toLowerCase())
      const q = userMessage.toLowerCase()
      return keywords.some((kw: string) => q.includes(kw) || kw.includes(q))
    })

    if (relevantSkills.length > 0) {
      skillSection = '\n\n## 激活的技能\n' +
        relevantSkills.map((s: any) =>
          `- [${s.name}] ${s.description}\n  ${s.prompt_template ? 'Prompt: ' + s.prompt_template : ''}`
        ).join('\n') +
        '\n\n请结合以上技能的专业知识和 prompt 模板来优化你的回复。'
    }
  } catch {
    // skills table might not exist yet
  }

  return `${basePrompt}\n\n## 你的能力\n你是一个智能 AI 代理，可以：\n1. 通过 memory_store 工具学习和记住用户信息\n2. 通过 web_search 搜索互联网获取实时信息\n3. 通过 web_fetch 读取网页内容\n4. 通过文件工具读写本地文件\n5. 通过 shell_exec 执行命令\n\n重要规则：\n- 主动使用工具完成任务，不要等待用户指令\n- 每次对话结束后，主动存储重要信息到记忆\n- 在回答前先搜索相关记忆和网络信息\n${memorySection}${relatedSection}${toolsSection}${skillSection}`
}

/**
 * 核心 Agent Loop
 * 循环调用 LLM + 执行工具，直到模型给出最终回复
 */
export async function runAgentLoop(
  ctx: Context,
  userMessages: Array<{ role: string; content: string }>,
  agentConfig: AgentConfig
) {
  const messages: AgentMessage[] = [
    ...userMessages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ]

  // 构建系统提示并注入记忆
  const lastUserMsg = [...userMessages].reverse().find((m) => m.role === 'user')
  const lastUserContent = typeof lastUserMsg?.content === 'string'
    ? lastUserMsg.content
    : Array.isArray(lastUserMsg?.content)
    ? lastUserMsg.content.find((p: any) => p.type === 'text')?.text || ''
    : ''
  const systemPrompt = buildSystemPrompt(
    agentConfig.systemPrompt,
    lastUserContent
  )

  let turn = 0
  let finished = false

  while (turn < agentConfig.maxTurns && !finished) {
    turn++
    emitSSE(ctx, 'thinking', { turn, message: `正在思考... (第 ${turn} 轮)` })

    const apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ]

    try {
      const response = await fetch(`${config.deepseek.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${agentConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: agentConfig.model,
          messages: apiMessages,
          temperature: agentConfig.temperature,
          max_tokens: agentConfig.maxTokens,
          stream: false,
          tools: toolDefinitions.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
          tool_choice: 'auto',
        }),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`API error ${response.status}: ${errorText}`)
      }

      const data = await response.json()
      const choice = data.choices?.[0]
      const msg = choice?.message

      if (!msg) {
        throw new Error('No message in response')
      }

      // 检查是否有工具调用
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // 发送工具调用事件
        for (const tc of msg.tool_calls) {
          emitSSE(ctx, 'tool_call', {
            name: tc.function.name,
            arguments: tc.function.arguments,
            id: tc.id,
          })
        }

        // 添加助手消息（含工具调用）
        const assistantMsg: AgentMessage = {
          role: 'assistant',
          content: msg.content || '',
          tool_calls: msg.tool_calls,
        }
        // thinking 模式：preserve reasoning_content 避免 400 错误
        if (msg.reasoning_content) {
          assistantMsg.reasoning_content = msg.reasoning_content
        }
        messages.push(assistantMsg)

        // 执行工具
        const toolResults = await executeToolCalls(msg.tool_calls)

        // 发送工具结果事件
        for (const result of toolResults) {
          // 找到对应的工具调用以获取名称
          const tc = msg.tool_calls.find((t: any) => t.id === result.tool_call_id)
          emitSSE(ctx, 'tool_result', {
            name: tc?.function?.name || 'unknown',
            content: result.content.slice(0, 500),
            tool_call_id: result.tool_call_id,
          })
          messages.push(result)
        }
      } else {
        // 最终回复 - 流式输出内容
        finished = true
        const content = msg.content || ''

        // 发送最终内容
        emitSSE(ctx, 'content', { content })

        // 记录最终回复（含 reasoning_content 便于调试）
        const finalMsg: AgentMessage = { role: 'assistant', content }
        if (msg.reasoning_content) {
          finalMsg.reasoning_content = msg.reasoning_content
        }
        messages.push(finalMsg)

        // 自动提取并存储记忆
        await autoExtractMemories(content, lastUserContent)
      }
    } catch (err: any) {
      emitSSE(ctx, 'error', { message: err.message })
      finished = true
    }
  }

  if (!finished) {
    emitSSE(ctx, 'content', { content: '(达到最大思考轮次，Agent 停止。)' })
  }

  emitSSE(ctx, 'done', { turns: turn })
}

/**
 * 自动从对话中提取重要信息并存储为记忆
 */
async function autoExtractMemories(assistantContent: string, userContent: string) {
  const db = getDB()

  // 简单的关键词提取：检查是否包含值得记忆的信息
  const memoryPatterns = [
    { pattern: /我叫\s*(\S+)/, key: '用户名称', category: 'preference' },
    { pattern: /我是\s*(.+)/, key: '用户身份', category: 'fact' },
    { pattern: /用\s*(.+)\s*语言/, key: '偏好语言', category: 'preference' },
    { pattern: /项目[名称是]*\s*[：:]\s*(.+)/, key: '项目名称', category: 'fact' },
    { pattern: /喜欢\s*(.+)/, key: '用户偏好', category: 'preference' },
  ]

  const combinedText = userContent + ' ' + assistantContent

  for (const { pattern, key, category } of memoryPatterns) {
    const match = combinedText.match(pattern)
    if (match && match[1]) {
      // 检查是否已存在
      const existing = db.prepare('SELECT id FROM agent_memory WHERE key = ?').get(key) as any
      if (!existing) {
        const id = randomUUID()
        db.prepare(
          'INSERT INTO agent_memory (id, key, content, category, importance) VALUES (?, ?, ?, ?, ?)'
        ).run(id, key, match[1], category, 3)
      }
    }
  }
}
