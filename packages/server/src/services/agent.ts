/**
 * Agent Loop 核心逻辑
 * 实现智能体的自主决策循环：思考 → 行动 → 观察 → 思考 ...
 *
 * P0 改造：
 * - 动态 maxTurns：根据任务复杂度 10~60 轮弹性伸缩
 * - 中间检查点：每 N 轮落盘状态，超限可从检查点续跑
 * - Planner 模式：复杂任务先规划再执行
 */
import { randomUUID } from 'crypto'
import { join } from 'path'
import { writeFile, mkdir } from 'fs/promises'
import type { Context } from 'koa'
import { config } from '../config'
import { getDB } from '../services/database'
import { toolDefinitions, executeToolCalls, type ToolCall, type ToolResultWithMeta, getToolMeta } from './tools'
import { classifyApiError, jitteredBackoff } from './error-classifier'
import { ToolGuardrailController } from './tool-guardrails'
import { shouldCompress, compressContext, pruneOldToolResults } from './context-compressor'

interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: ToolCall[]
  tool_call_id?: string
  reasoning_content?: string
}

interface AgentConfig {
  model: string
  apiKey: string
  baseUrl?: string
  temperature: number
  maxTokens: number
  systemPrompt: string
  maxTurns: number
}

interface AgentCheckpoint {
  id: string
  turn: number
  messages: AgentMessage[]
  createdFiles: Array<{ name: string; path: string; mime: string; size?: number }>
  totalToolCalls: string[]
  timestamp: string
}

// ---- P0: 动态 maxTurns 配置 ----
const TURN_CONFIG = {
  CHECKPOINT_INTERVAL: 5,       // 每 5 轮存一次检查点
  BASE_MAX_TURNS: 50,           // 默认最大轮次
  SIMPLE_TASK_TURNS: 10,        // 简单任务（问候/知识问答）
  COMPLEX_TASK_TURNS: 60,       // 复杂任务（全局诊断/代码重构）
  PLANNER_OVERHEAD: 4,          // Planner 模式的规划轮次开销
}

/** 估计任务复杂度，返回建议 maxTurns */
function estimateComplexity(userMessages: Array<{ role: string; content: string }>): number {
  const lastMsg = [...userMessages].reverse().find(m => m.role === 'user')?.content || ''
  const allText = userMessages.map(m => m.content).join(' ').toLowerCase()

  // 复杂任务关键词
  const complexPatterns = [
    /全局诊断|全面检查|代码审计|全量|全部|所有|整个项目|重构|全面优化/,
    /review.*all|audit.*all|full.*check|entire.*project|refactor.*all/i,
    /分析.*所有|检查.*所有|扫描.*全部/,
    /planner|plan.*mode|计划.*执行/,
  ]

  // 简单任务关键词
  const simplePatterns = [
    /你好|你是谁|hello|hi|hey|什么是|什么是|怎么|如何/,
    /what is|who are|tell me|explain/,
  ]

  for (const p of complexPatterns) {
    if (p.test(allText)) return TURN_CONFIG.COMPLEX_TASK_TURNS
  }

  for (const p of simplePatterns) {
    if (p.test(lastMsg)) return TURN_CONFIG.SIMPLE_TASK_TURNS
  }

  // 工具调用密度估计：消息越长、越结构化 → 越复杂
  const msgCount = userMessages.length
  const totalLen = allText.length
  if (msgCount > 5 || totalLen > 1000) return Math.min(TURN_CONFIG.BASE_MAX_TURNS + 15, TURN_CONFIG.COMPLEX_TASK_TURNS)

  return TURN_CONFIG.BASE_MAX_TURNS
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
function buildSystemPrompt(basePrompt: string, userMessage: string, model?: string): { prompt: string; matchedSkills: string[]; allowedTools: string[] } {
  const db = getDB()

  // 读取记忆开关
  const memoryEnabledRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryEnabled') as any
  const memoryEnabled = memoryEnabledRow ? memoryEnabledRow.value === 'true' : true

  const memoryCharLimitRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryCharLimit') as any
  const memoryLimit = memoryCharLimitRow ? parseInt(memoryCharLimitRow.value) || 50000 : 50000
  const memoryItemLimit = Math.max(5, Math.floor(memoryLimit / 2000))  // 按字符预算估算条数

  const memories = memoryEnabled ? db.prepare(
    `SELECT key, content, category, importance FROM agent_memory ORDER BY importance DESC LIMIT ${memoryItemLimit}`
  ).all() as any[] : []

  let memorySection = ''
  if (memories.length > 0) {
    memorySection = '\n\n## Stored Memories\n' +
      memories.map((m: any) => `- [${m.key}] (${m.category}, importance:${m.importance}) ${m.content}`).join('\n') +
      '\n\nUse these memories to personalize your responses. Use the memory_store tool to save important new information.'
  }

  const relatedMemories = memoryEnabled ? db.prepare(
    `SELECT key, content, importance FROM agent_memory
     WHERE content LIKE ? LIMIT 5`
  ).all(`%${userMessage.slice(0, 50)}%`) as any[] : []

  let relatedSection = ''
  if (relatedMemories.length > 0 && memories.length > 5) {
    relatedSection = '\n\n## Related Memories\n' +
      relatedMemories.map((m: any) => `- [${m.key}] ${m.content}`).join('\n')
  }

  const toolsSection = `\n\n## Available Tools\nYou can use the following tools. Call them automatically when needed.\n- memory_store: Store important user info to long-term memory\n- memory_recall: Search stored memories\n- memory_list: List all memories\n- web_search: Search the internet\n- web_fetch: Fetch web page content\n- file_read/file_write/file_exists: Read/write/check local files\n- shell_exec: Execute shell commands\n- skill_list: List all installed skills\n- skill_search: Search for third-party skills on GitHub\n- skill_view: View skill details and prompt template\n- skill_install: Install a skill from a GitHub repository`

  let skillIndexSection = ''
  let skillSection = ''
  let matchedSkills: string[] = []
  let skillTools: string[] = []

  try {
    const allSkills = db.prepare(
      `SELECT name, description, prompt_template, tools, trigger_keywords FROM skills WHERE enabled = 1`
    ).all() as any[]

    if (allSkills.length > 0) {
      skillIndexSection = '\n\n## Installed Skills\n' +
        allSkills.map((s: any) => `- [${s.name}] ${s.description}`).join('\n') +
        '\n\nUse skill_list() for details, skill_search() to find new skills, skill_install() to install.'
    }

    const relevantSkills = allSkills.filter((s: any) => {
      if (!s.trigger_keywords) return false
      const keywords = s.trigger_keywords.split(',').map((k: string) => k.trim().toLowerCase())
      const q = userMessage.toLowerCase()
      return keywords.some((kw: string) => q.includes(kw) || kw.includes(q))
    })

    if (relevantSkills.length > 0) {
      matchedSkills = relevantSkills.map((s: any) => s.name)
      skillSection = '\n\n## Activated Skills\n' +
        relevantSkills.map((s: any) =>
          `- [${s.name}] ${s.description}\n  ${s.prompt_template ? 'Prompt: ' + s.prompt_template : ''}`
        ).join('\n') +
        '\n\nCombine the expertise and prompt templates of the above skills to optimize your response.'

      for (const s of relevantSkills) {
        if (s.tools) {
          try {
            const tools = typeof s.tools === 'string' ? JSON.parse(s.tools) : s.tools
            if (Array.isArray(tools)) skillTools.push(...tools)
          } catch {}
        }
      }
    }
  } catch {}

  const baseTools = ['memory_store', 'memory_recall', 'memory_list', 'skill_list', 'skill_search', 'skill_view', 'skill_install']
  const allowedTools = [...new Set([...baseTools, ...skillTools])]

  const prompt = `${basePrompt}

## Your Setup
- Model: **${model || 'deepseek-v4-pro'}** | Platform: SuperCrzy Agent
- Tools: file, shell, web search, memory, skills

## Core Principle
The deliverable is a working result backed by real tool output — not a description of one.
Do not stop at a plan or a stub. Keep going until the task is done and you can show real output.
If something blocks you, say so directly. Never fabricate results.

## Rules
1. Simple questions → answer directly. No tools needed.
2. Tasks → do them end to end. Run it, verify it works, show the output.
3. Something fails → try a different way immediately.
4. Stuck after 2 tries → tell the user what's blocking you.
5. Be concise. Show results, not process.
6. Don't narrate what you're about to do. Just do it.

## Memory
Save important facts with memory_store. Retrieve with memory_recall.

${memorySection}${relatedSection}${toolsSection}${skillIndexSection}${skillSection}`

  return { prompt, matchedSkills, allowedTools }
}

/**
 * P0: 保存检查点到文件系统
 */
async function saveCheckpoint(checkpoint: AgentCheckpoint): Promise<string> {
  const dir = join(config.workspaceDir, 'data', 'checkpoints')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${checkpoint.id}.json`)
  await writeFile(path, JSON.stringify(checkpoint, null, 2), 'utf-8')
  return path
}

/**
 * 核心 Agent Loop
 * P0: 动态 maxTurns + 检查点 + 续跑
 */
/** 标准化 base URL，确保不会出现双重 /v1 */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/v1\/?$/, '')
}

export async function runAgentLoop(
  ctx: Context,
  userMessages: Array<{ role: string; content: string }>,
  agentConfig: AgentConfig,
  resumeCheckpoint?: string,  // P0: 从检查点续跑
) {
  // ---- 动态 maxTurns ----
  // 用户配置的 maxTurns 就是上限，简单任务靠 estimateComplexity 自动缩短
  const effectiveMaxTurns = resumeCheckpoint
    ? agentConfig.maxTurns
    : (agentConfig.maxTurns || 80)

  const checkpointId = randomUUID()

  emitSSE(ctx, 'config', {
    maxTurns: effectiveMaxTurns,
    checkpointId,
    resumed: !!resumeCheckpoint,
  })

  // ---- 消息初始化（支持续跑） ----
  let messages: AgentMessage[]
  let resumedTurn = 0  // 检查点恢复时的轮次

  if (resumeCheckpoint) {
    // 从检查点恢复
    try {
      const { readFile } = await import('fs/promises')
      const ckptData = await readFile(resumeCheckpoint, 'utf-8')
      const ckpt: AgentCheckpoint = JSON.parse(ckptData)
      messages = ckpt.messages
      resumedTurn = ckpt.turn || 0
      // P0: 添加继续执行提示，否则 Agent 看到完整历史会认为任务已完成
      messages.push({
        role: 'user',
        content: `[系统提示] 你正在从检查点恢复执行（第 ${ckpt.turn} 轮）。请继续完成之前未完成的任务，不要重复已完成的工作。`
      })
      emitSSE(ctx, 'checkpoint_resumed', {
        fromTurn: ckpt.turn,
        savedFiles: ckpt.createdFiles.length,
        toolCalls: ckpt.totalToolCalls.length,
      })
    } catch (err: any) {
      emitSSE(ctx, 'error', { message: `Failed to resume checkpoint: ${err.message}` })
      messages = userMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    }
  } else {
    messages = userMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  }

  const lastUserMsg = [...userMessages].reverse().find(m => m.role === 'user')
  const lastUserContent = lastUserMsg?.content as string || ''
  const systemPrompt = buildSystemPrompt(agentConfig.systemPrompt, lastUserContent, agentConfig.model)

  for (const skillName of systemPrompt.matchedSkills) {
    emitSSE(ctx, 'skill_matched', { name: skillName })
  }

  const activeToolDefs = systemPrompt.allowedTools.length > 3
    ? toolDefinitions.filter(t => systemPrompt.allowedTools.includes(t.name))
    : toolDefinitions

  let turn = resumedTurn  // 从检查点恢复轮次
  let finished = false
  const createdFiles: Array<{ name: string; path: string; mime: string; size?: number }> = []
  const totalToolCalls: string[] = []
  let lastCheckpointTurn = 0
  let toolErrorCount = 0  // 工具失败计数器，避免无限重试提示
  let consecutiveApiErrors = 0  // API 连续错误计数器
  let compressionAttempts = 0  // 压缩尝试次数
  let emptyContentCount = 0  // 空内容重试计数
  const guardrail = new ToolGuardrailController()  // 工具循环防护
  let roundStartMs = Date.now()
  const roundDurationsMs: number[] = []

  // ---- P0: Planner Mode ----
  // 在首轮之前，先让 LLM 规划复杂任务
  let plannerSteps: string[] = []

  if (effectiveMaxTurns >= TURN_CONFIG.COMPLEX_TASK_TURNS) {
    emitSSE(ctx, 'planner_start', { message: '🔍 检测到复杂任务，启用 Planner 模式...' })

    // 先做一次无工具的规划调用，让 LLM 列出执行步骤
    const planMessages = [
      { role: 'system', content: `${systemPrompt.prompt}

你现在处于 Planner 模式。请分析用户任务，输出一个分步执行计划（用简洁的 checklist 格式）。不要调用工具，只做分析。` },
      ...messages,
      { role: 'system', content: '请列出执行计划（每行一个步骤，带编号）：' },
    ]

    try {
      const planResp = await fetch(`${normalizeBaseUrl(agentConfig.baseUrl || config.deepseek.baseUrl)}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(agentConfig.apiKey.startsWith('tp-') ? { 'api-key': agentConfig.apiKey } : { Authorization: `Bearer ${agentConfig.apiKey}` }) },
        body: JSON.stringify({
          model: agentConfig.model, messages: planMessages,
          temperature: 0.3, max_tokens: 800, stream: false,
        }),
      })
      if (planResp.ok) {
        const planData = await planResp.json() as any
        const planText = planData.choices?.[0]?.message?.content || ''
        // 解析出步骤
        const stepLines = planText.split('\n').filter((l: string) => /^\d+[\.\)\-]/.test(l.trim()) || l.trim().startsWith('- ['))
        if (stepLines.length > 0) {
          plannerSteps = stepLines
          emitSSE(ctx, 'planner_plan', { steps: plannerSteps, raw: planText.slice(0, 500) })
        } else {
          emitSSE(ctx, 'planner_plan', { steps: [planText.slice(0, 300)], raw: planText.slice(0, 300) })
        }
      }
    } catch (planErr: any) {
      emitSSE(ctx, 'planner_plan', { steps: ['(规划调用失败，直接执行)'], error: planErr.message })
    }
  }

  while (turn < effectiveMaxTurns && !finished) {
    turn++
    const roundDuration = turn > 1 ? Date.now() - roundStartMs : 0
    if (roundDuration > 0) roundDurationsMs.push(roundDuration)
    roundStartMs = Date.now()
    const avgRoundMs = roundDurationsMs.length > 0
      ? Math.round(roundDurationsMs.reduce((a, b) => a + b, 0) / roundDurationsMs.length)
      : 0
    const remaining = effectiveMaxTurns - turn
    const etaMs = avgRoundMs > 0 ? avgRoundMs * remaining : 0
    emitSSE(ctx, 'thinking', {
      turn,
      maxTurns: effectiveMaxTurns,
      remaining,
      avgRoundMs,
      etaMs,
      message: `思考中...`,
    })

    // ---- 上下文压缩：主动裁剪旧工具结果 + 旧 reasoning + 按需 LLM 摘要 ----
    if (turn > 3 && turn % 3 === 0) {
      // 轻量裁剪：每 3 轮裁剪一次旧工具结果
      messages = pruneOldToolResults(messages, 5)
      // 裁剪旧消息的 reasoning_content（保留最近 3 条）
      let reasoningCount = 0
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].reasoning_content) {
          reasoningCount++
          if (reasoningCount > 3) {
            const oldLen = (messages[i].reasoning_content as string).length
            messages[i].reasoning_content = `[reasoning 已裁剪，原长 ${oldLen} 字符]`
          }
        }
      }
    }
    if (turn > 5 && shouldCompress(messages) && compressionAttempts < 3) {
      compressionAttempts++
      emitSSE(ctx, 'compressing', { attempt: compressionAttempts, message: '上下文过长，正在压缩...' })
      const baseUrl = agentConfig.baseUrl || config.deepseek.baseUrl
      const result = await compressContext(messages, agentConfig.apiKey, baseUrl)
      if (result.compressed) {
        messages = result.messages as AgentMessage[]
        emitSSE(ctx, 'compressed', { savedTokens: result.savedTokens })
      }
    }

    const apiMessages = [
      { role: 'system', content: systemPrompt.prompt },
      ...messages,
    ]

    // P0: 在接近上限时提示模型压缩输出
    if (turn > effectiveMaxTurns - 5 && turn < effectiveMaxTurns) {
      apiMessages.push({
        role: 'system',
        content: `⚠️ 只剩 ${effectiveMaxTurns - turn} 轮思考机会。请尽快给出结论，避免调用非必要工具。完成后不要继续调工具。`,
      })
    }

    try {
      const requestBody = JSON.stringify({
        model: agentConfig.model,
        messages: apiMessages,
        temperature: agentConfig.temperature,
        max_tokens: agentConfig.maxTokens,
        stream: true,
        tools: activeToolDefs.map(t => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
        tool_choice: 'auto',
        reasoning_effort: 'low',
      })

      const response = await fetch(`${normalizeBaseUrl(agentConfig.baseUrl || config.deepseek.baseUrl)}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(agentConfig.apiKey.startsWith('tp-')
            ? { 'api-key': agentConfig.apiKey }
            : { Authorization: `Bearer ${agentConfig.apiKey}` }),
        },
        body: requestBody,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`API error ${response.status}: ${errorText}`)
      }

      consecutiveApiErrors = 0  // API 调用成功，重置错误计数

      const reader = response.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let buffer = ''
      let contentBuffer = ''
      let reasoningBuffer = ''
      const toolCallBuffer: Map<number, { id: string; name: string; args: string }> = new Map()

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          // Flush decoder buffer and process remaining data
          buffer += decoder.decode()
          const remainingLines = buffer.split("\n")
          for (const line of remainingLines) {
            if (!line.startsWith("data: ")) continue
            const ds = line.slice(6).trim()
            if (ds === "[DONE]") continue
            try {
              const ch = JSON.parse(ds)
              const dl = ch.choices?.[0]?.delta
              if (dl?.content) {
                contentBuffer += dl.content
                if (!(contentBuffer.startsWith("{") || contentBuffer.startsWith("["))) {
                  emitSSE(ctx, "content_chunk", { text: dl.content })
                }
              }
              if (dl?.tool_calls) {
                for (const tc of dl.tool_calls) {
                  const ix = tc.index ?? 0
                  if (!toolCallBuffer.has(ix)) {
                    toolCallBuffer.set(ix, { id: tc.id || "", name: "", args: "" })
                  }
                  const en = toolCallBuffer.get(ix)!
                  if (tc.id) en.id = tc.id
                  if (tc.function?.name) en.name += tc.function.name
                  if (tc.function?.arguments) en.args += tc.function.arguments
                }
              }
            } catch {}
          }
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const dataStr = line.slice(6).trim()
          if (dataStr === '[DONE]') continue

          try {
            const chunk = JSON.parse(dataStr)
            const delta = chunk.choices?.[0]?.delta

            if (delta?.content) {
              contentBuffer += delta.content
              if (!(contentBuffer.startsWith('{') || contentBuffer.startsWith('['))) {
                emitSSE(ctx, 'content_chunk', { text: delta.content })
              }
            }

            if (delta?.reasoning_content) {
              reasoningBuffer += delta.reasoning_content
              emitSSE(ctx, 'thinking_chunk', { text: delta.reasoning_content, turn })
            }

            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0
                if (!toolCallBuffer.has(idx)) {
                  toolCallBuffer.set(idx, { id: tc.id || '', name: '', args: '' })
                }
                const entry = toolCallBuffer.get(idx)!
                if (tc.id) entry.id = tc.id
                if (tc.function?.name) entry.name += tc.function.name
                if (tc.function?.arguments) entry.args += tc.function.arguments
              }
            }
          } catch {}
        }
      }

      if (toolCallBuffer.size > 0) {
        const toolCalls = Array.from(toolCallBuffer.values()).map(tc => ({
          id: tc.id || randomUUID(),
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.args },
        }))

        const SENSITIVE_TOOLS = new Set(['shell_exec', 'file_write', 'file_delete'])
        for (const tc of toolCalls) {
          totalToolCalls.push(tc.function.name)
          const isSensitive = SENSITIVE_TOOLS.has(tc.function.name)
          emitSSE(ctx, 'tool_call', {
            name: tc.function.name,
            arguments: tc.function.arguments,
            id: tc.id,
            status: isSensitive ? 'pending' : 'running',
          })
        }

        const assistantMsg: any = {
          role: 'assistant',
        }
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls
          // content 在 tool_calls 存在时应省略（不设 null，避免 DeepSeek V4 将其解释为复杂内容类型）
        } else {
          assistantMsg.content = contentBuffer || ''
        }
        if (reasoningBuffer) assistantMsg.reasoning_content = reasoningBuffer
        messages.push(assistantMsg)

        // P0: wrap executeToolCalls with 60s per-tool timeout
        const toolResults = await Promise.race([
          executeToolCalls(toolCalls as any),
          new Promise<any[]>((_, reject) =>
            setTimeout(() => reject(new Error("工具执行超时（60秒）")), 60000)
          ),
        ])

        for (const result of toolResults) {
          const tc = toolCalls.find((t: any) => t.id === result.tool_call_id)
          const toolName = tc?.function?.name || 'unknown'
          emitSSE(ctx, 'tool_result', {
            name: toolName,
            content: result.content.slice(0, 500),
            tool_call_id: result.tool_call_id,
          })
          if (result.duration) {
            emitSSE(ctx, 'tool_duration', { name: toolName, duration: result.duration })
          }
          messages.push(result)

          // ---- 工具循环防护：签名级追踪 ----
          const toolArgs = tc?.function?.arguments || ''
          const guardResult = guardrail.recordResult(toolName, toolArgs, result.content)
          if (guardResult.decision === 'halt') {
            emitSSE(ctx, 'tool_guardrail', { decision: 'halt', toolName, message: guardResult.message })
            messages.push({ role: 'system', content: guardResult.message! })
            // halt 意味着这个工具完全不能用了，但不终止整个循环，让模型换方法
          } else if (guardResult.decision === 'block') {
            emitSSE(ctx, 'tool_guardrail', { decision: 'block', toolName, message: guardResult.message })
            messages.push({ role: 'system', content: guardResult.message! })
          } else if (guardResult.decision === 'warn') {
            emitSSE(ctx, 'tool_guardrail', { decision: 'warn', toolName, message: guardResult.message })
            messages.push({ role: 'system', content: guardResult.message! })
          }

          if (toolName === 'file_write') {
            try {
              const args = JSON.parse(tc?.function?.arguments || '{}')
              const filePath = args.path || args.file_path || args.filePath
              if (filePath) {
                const parts = filePath.split('/')
                const name = parts[parts.length - 1] || filePath
                const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : ''
                const mimeMap: Record<string, string> = {
                  md: 'text/markdown', txt: 'text/plain', json: 'application/json',
                  html: 'text/html', css: 'text/css', js: 'application/javascript',
                  ts: 'application/typescript', py: 'text/x-python',
                  png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml',
                }
                const fileInfo = { name, path: filePath, mime: mimeMap[ext || ''] || 'text/plain', size: (tc?.function?.arguments?.length || result.content?.length) }
                createdFiles.push(fileInfo)
                emitSSE(ctx, 'file_created', fileInfo)
              }
            } catch {}
          }
        }
      } else {
        // ---- 空内容兜底：模型只返回 reasoning 没有实际内容 ----
        if (!contentBuffer || contentBuffer.trim().length === 0) {
          emptyContentCount++
          if (emptyContentCount <= 2) {
            emitSSE(ctx, 'empty_content_retry', { attempt: emptyContentCount })
            // 注入提示让模型输出实际内容，不要继续 reasoning
            messages.push({
              role: 'system',
              content: `你的上一条回复是空的。请直接输出你的回答内容，不要继续内部推理。用简洁的文字回复用户。`,
            })
            continue  // 重试
          }
          // 重试 2 次仍然为空，用 reasoning 内容兜底
          let fallbackContent = '抱歉，模型未能生成回复。请重试或换个问法。'
          if (reasoningBuffer && reasoningBuffer.length > 50) {
            // 从 reasoning 中提取可能的有用内容（去掉思考过程的前缀）
            const cleaned = reasoningBuffer
              .replace(/^思考中\.\.\./, '')
              .replace(/^第 \d+\/\d+ 轮思考\.\.\./, '')
              .trim()
            if (cleaned.length > 30) {
              fallbackContent = `*（模型进行了推理但未生成格式化回复，以下是推理摘要）*\n\n${cleaned.slice(0, 800)}${cleaned.length > 800 ? '...' : ''}`
            }
          }
          emitSSE(ctx, 'content', { content: fallbackContent })
          finished = true
          break
        }

        finished = true
        emitSSE(ctx, 'content', { content: contentBuffer })

        const finalMsg: AgentMessage = { role: 'assistant', content: contentBuffer }
        if (reasoningBuffer) finalMsg.reasoning_content = reasoningBuffer
        messages.push(finalMsg)

        await autoExtractMemories(contentBuffer, lastUserContent)
      }

      // ---- P0: 中间检查点 ----
      if (!finished && turn - lastCheckpointTurn >= TURN_CONFIG.CHECKPOINT_INTERVAL) {
        lastCheckpointTurn = turn
        const checkpoint: AgentCheckpoint = {
          id: checkpointId,
          turn,
          messages: [...messages],
          createdFiles: [...createdFiles],
          totalToolCalls: [...totalToolCalls],
          timestamp: new Date().toISOString(),
        }
        const ckptPath = await saveCheckpoint(checkpoint)
        emitSSE(ctx, 'checkpoint', {
          turn,
          path: ckptPath,
          files: createdFiles.length,
          toolCalls: totalToolCalls.length,
        })
      }
    } catch (err: any) {
      const classified = classifyApiError(err)
      console.warn(`[Agent] Error (${classified.reason}): ${classified.message.slice(0, 200)}`)

      // ---- 上下文溢出：压缩后重试 ----
      if (classified.shouldCompress && compressionAttempts < 3) {
        compressionAttempts++
        emitSSE(ctx, 'compressing', { attempt: compressionAttempts, reason: classified.reason })
        const baseUrl = agentConfig.baseUrl || config.deepseek.baseUrl
        const result = await compressContext(messages, agentConfig.apiKey, baseUrl)
        if (result.compressed) {
          messages = result.messages as AgentMessage[]
          emitSSE(ctx, 'compressed', { savedTokens: result.savedTokens })
          continue  // 压缩后重试
        }
      }

      // ---- 需要 fallback：通知用户但不重试 ----
      if (classified.shouldFallback) {
        emitSSE(ctx, 'error', {
          message: `[${classified.reason}] ${classified.message.slice(0, 200)}`,
          needFallback: true,
          reason: classified.reason,
        })
        emitSSE(ctx, 'content', {
          content: `API 服务异常 (${classified.reason})，建议切换模型或稍后重试。\n\n详情: ${classified.message.slice(0, 300)}`,
          error: true,
        })
        finished = true
        break
      }

      // ---- 可重试：退避后继续 ----
      if (classified.retryable) {
        consecutiveApiErrors++
        if (consecutiveApiErrors > 3) {
          emitSSE(ctx, 'error', { message: `连续 ${consecutiveApiErrors} 次失败 (${classified.reason})，停止重试` })
          emitSSE(ctx, 'content', {
            content: `抱歉，连续 ${consecutiveApiErrors} 次 API 失败 (${classified.reason})。请稍后再试。\n\n错误: ${classified.message.slice(0, 300)}`,
            error: true,
          })
          finished = true
        } else {
          const backoffMs = jitteredBackoff(consecutiveApiErrors)
          emitSSE(ctx, 'error', {
            message: `${classified.reason} (${consecutiveApiErrors}/3)，${Math.round(backoffMs/1000)}s 后重试...`,
            retrying: true,
            reason: classified.reason,
          })
          await new Promise(r => setTimeout(r, backoffMs))
          continue
        }
      } else {
        // 不可重试的错误
        emitSSE(ctx, 'error', { message: `[${classified.reason}] ${classified.message.slice(0, 200)}` })
        emitSSE(ctx, 'content', { content: `执行出错 (${classified.reason}): ${classified.message.slice(0, 300)}`, error: true })
        finished = true
      }
    }
  }

  // ---- P0: 超限处理 ----
  if (!finished) {
    // 先保存最终检查点
    const finalCheckpoint: AgentCheckpoint = {
      id: checkpointId,
      turn,
      messages: [...messages],
      createdFiles: [...createdFiles],
      totalToolCalls: [...totalToolCalls],
      timestamp: new Date().toISOString(),
    }
    const ckptPath = await saveCheckpoint(finalCheckpoint)

    // 发送可操作的超限事件
    emitSSE(ctx, 'turn_limit_reached', {
      turns: turn,
      maxTurns: effectiveMaxTurns,
      checkpointPath: ckptPath,
      checkpointId,
      createdFiles: createdFiles.map(f => ({ name: f.name, path: f.path, mime: f.mime })),
      toolCallCount: totalToolCalls.length,
      message: `已达 ${effectiveMaxTurns} 轮上限。已保存检查点，可在 Settings 调整 maxTurns 后继续。`,
    })

    // 也发 content 事件让前端有内容可读
    emitSSE(ctx, 'content', {
      content: `📋 **任务进行到第 ${turn}/${effectiveMaxTurns} 轮，未完成。**

| 信息 | 值 |
|------|-----|
| 检查点 ID | \`${checkpointId}\` |
| 已产生文件 | ${createdFiles.length} 个 |
| 工具调用 | ${totalToolCalls.length} 次 |
| 上次检查点 | 第 ${lastCheckpointTurn} 轮 |

**如何继续？** 在 Settings → Agent 里调大 maxTurns（建议 60+），然后发送 \`继续检查点 ${checkpointId}\` 接着跑。`,
    })
  }

  if (createdFiles.length > 0) {
    emitSSE(ctx, 'delivery_summary', {
      artifacts: createdFiles.map(f => ({ name: f.name, path: f.path, mime: f.mime })),
      artifactCount: createdFiles.length,
      toolCallCount: totalToolCalls.length,
      turns: turn,
    })
  }

  emitSSE(ctx, 'done', { turns: turn, maxTurns: effectiveMaxTurns, finished, summary: createdFiles.length > 0 ? `任务完成，共产生 ${createdFiles.length} 个文件` : undefined })
}

/**
 * 自动从对话中提取重要信息并存储为记忆
 */
async function autoExtractMemories(assistantContent: string, userContent: string) {
  const db = getDB()

  // 记忆开关关闭时不提取
  const memoryEnabledRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('memoryEnabled') as any
  if (memoryEnabledRow && memoryEnabledRow.value !== 'true') return

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
