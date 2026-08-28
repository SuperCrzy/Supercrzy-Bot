/**
 * 上下文压缩器
 * 当消息历史过长时，用便宜模型生成结构化摘要替换中间轮次
 *
 * 设计原则：
 * - 预估 token 超过阈值时触发
 * - 保护头部（system prompt + 前几轮）和尾部（最近 20K tokens）
 * - 中间部分用 LLM 生成摘要替换
 * - 最多压缩 3 次，避免无限压缩
 */

interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<{ type: string; text?: string }>
  tool_calls?: any[]
  tool_call_id?: string
  reasoning_content?: string
}

// 配置
const COMPRESSION_CONFIG = {
  THRESHOLD_RATIO: 0.55,         // 超过上下文窗口 55% 时触发
  TARGET_RATIO: 0.30,            // 压缩到 30%
  MAX_CONTEXT_TOKENS: 128000,    // 默认上下文窗口大小
  PROTECT_HEAD: 3,               // 保护前 3 条非 system 消息
  PROTECT_TAIL_TOKENS: 20000,    // 保护尾部约 20K tokens
  MAX_SUMMARY_TOKENS: 3000,      // 摘要上限
  MAX_COMPRESS_ATTEMPTS: 3,      // 最多压缩次数
}

/**
 * 粗估 token 数（1 中文字 ≈ 2 tokens，1 英文词 ≈ 1.3 tokens）
 */
function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const remaining = text.length - chineseChars
  return Math.ceil(chineseChars * 2 + remaining * 0.4)
}

/**
 * 提取消息的纯文本内容
 */
function getMessageText(msg: AgentMessage): string {
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content.map(c => c.text || '').join(' ')
  }
  return ''
}

/**
 * 估算整个 messages 数组的 token 数
 */
export function estimateMessagesTokens(messages: AgentMessage[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateTokens(getMessageText(msg))
    if (msg.reasoning_content) total += estimateTokens(msg.reasoning_content)
    if (msg.tool_calls) total += estimateTokens(JSON.stringify(msg.tool_calls))
  }
  return total
}

/**
 * 判断是否需要压缩
 * @param contextWindow 模型上下文窗口（tokens），不传用默认 128K —— 支持按模型动态配置
 */
export function shouldCompress(messages: AgentMessage[], contextWindow?: number): boolean {
  const tokens = estimateMessagesTokens(messages)
  const window = contextWindow && contextWindow > 0 ? contextWindow : COMPRESSION_CONFIG.MAX_CONTEXT_TOKENS
  const threshold = window * COMPRESSION_CONFIG.THRESHOLD_RATIO
  return tokens > threshold
}

/**
 * 执行上下文压缩
 * 返回压缩后的 messages 数组
 */
export async function compressContext(
  messages: AgentMessage[],
  apiKey: string,
  baseUrl: string,
): Promise<{ messages: AgentMessage[]; compressed: boolean; savedTokens: number }> {
  const beforeTokens = estimateMessagesTokens(messages)

  // 1. 分离 system 消息
  const systemMsgs = messages.filter(m => m.role === 'system')
  const nonSystemMsgs = messages.filter(m => m.role !== 'system')

  if (nonSystemMsgs.length < 6) {
    return { messages, compressed: false, savedTokens: 0 }
  }

  // 2. 保护头部
  const headCount = COMPRESSION_CONFIG.PROTECT_HEAD
  const headMsgs = nonSystemMsgs.slice(0, headCount)

  // 3. 保护尾部（从后往前数，直到 token 预算用完）
  let tailTokens = 0
  let tailStart = nonSystemMsgs.length
  for (let i = nonSystemMsgs.length - 1; i >= headCount; i--) {
    const msgTokens = estimateTokens(getMessageText(nonSystemMsgs[i]))
    if (tailTokens + msgTokens > COMPRESSION_CONFIG.PROTECT_TAIL_TOKENS) break
    tailTokens += msgTokens
    tailStart = i
  }
  const tailMsgs = nonSystemMsgs.slice(tailStart)

  // 4. 中间部分 → 生成摘要
  const middleMsgs = nonSystemMsgs.slice(headCount, tailStart)
  if (middleMsgs.length < 2) {
    return { messages, compressed: false, savedTokens: 0 }
  }

  // 构建摘要请求
  const middleText = middleMsgs.map(m => {
    const role = m.role === 'user' ? '👤 User' : m.role === 'assistant' ? '🤖 Assistant' : '🔧 Tool'
    const text = getMessageText(m).slice(0, 500)
    return `[${role}]: ${text}`
  }).join('\n')

  const summaryPrompt = `请将以下对话历史压缩为结构化摘要。保留关键信息，丢弃冗余细节。

输出格式：
## 已完成的工作
- 列出已完成的关键操作和结果

## 当前进行中
- 列出正在进行的任务和状态

## 关键上下文
- 保留重要的文件路径、配置、决策等

## 待完成
- 列出尚未完成的任务

对话历史：
${middleText.slice(0, 8000)}`

  try {
    const response = await fetch(`${baseUrl.replace(/\/v1\/?$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey.startsWith('tp-')
          ? { 'api-key': apiKey }
          : { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',  // 用便宜模型
        messages: [
          { role: 'system', content: '你是一个对话摘要助手。简洁、结构化地总结对话内容。' },
          { role: 'user', content: summaryPrompt },
        ],
        max_tokens: COMPRESSION_CONFIG.MAX_SUMMARY_TOKENS,
        temperature: 0.3,
      }),
    })

    if (!response.ok) {
      console.warn('[Compressor] Summary API failed:', response.status)
      return { messages, compressed: false, savedTokens: 0 }
    }

    const data = await response.json() as any
    const summary = data.choices?.[0]?.message?.content || ''

    if (!summary || summary.length < 50) {
      return { messages, compressed: false, savedTokens: 0 }
    }

    // 5. 组装压缩后的 messages
    const summaryMsg: AgentMessage = {
      role: 'system',
      content: `[上下文压缩摘要 — 以下是之前 ${middleMsgs.length} 轮对话的结构化总结]\n\n${summary}`,
    }

    const compressed = [
      ...systemMsgs,
      ...headMsgs,
      summaryMsg,
      ...tailMsgs,
    ]

    const afterTokens = estimateMessagesTokens(compressed)
    const savedTokens = beforeTokens - afterTokens

    console.log(`[Compressor] ${beforeTokens} → ${afterTokens} tokens (saved ${savedTokens}, ${middleMsgs.length} msgs → 1 summary)`)

    return { messages: compressed, compressed: true, savedTokens }
  } catch (err: any) {
    console.warn('[Compressor] Error:', err.message)
    return { messages, compressed: false, savedTokens: 0 }
  }
}

/**
 * 裁剪历史中的大工具结果（不调用 LLM 的轻量压缩）
 * 将旧的长工具结果替换为一行摘要
 */
export function pruneOldToolResults(messages: AgentMessage[], keepLastN = 5): AgentMessage[] {
  let toolCount = 0
  const result: AgentMessage[] = []

  // 从后往前数 tool 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') toolCount++
  }

  let toolIndex = 0
  for (const msg of messages) {
    if (msg.role === 'tool') {
      toolIndex++
      const isOld = toolIndex <= toolCount - keepLastN
      const text = getMessageText(msg)
      if (isOld && text.length > 500) {
        result.push({
          ...msg,
          content: `[工具结果已裁剪，原长 ${text.length} 字符] ${text.slice(0, 100)}...`,
        })
        continue
      }
    }
    result.push(msg)
  }

  return result
}
