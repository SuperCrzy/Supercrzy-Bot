/**
 * DeepSeek Agent CLI
 * 终端对话工具 — 直接在命令行中与 DeepSeek Agent 对话
 *
 * 用法: npx tsx src/cli.ts
 *       pnpm cli
 */
import * as readline from 'readline'
import { config } from './config/index.js'
import { initDatabase, getDB } from './services/database.js'

const SYSTEM_PROMPT = `You are DeepSeek Agent, a helpful AI assistant. Answer in the same language the user uses. Be concise and practical.`

interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const conversationHistory: Message[] = []
let agentMode = false
const API_KEY = process.env.DEEPSEEK_API_KEY || config.deepseek.apiKey
const BASE_URL = config.deepseek.baseUrl
const MODEL = config.deepseek.defaultModel

// ANSI color codes
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
}

function banner() {
  console.log(`
${C.cyan}${C.bold}╔══════════════════════════════════════╗
║      DeepSeek Agent — CLI Mode      ║
╚══════════════════════════════════════╝${C.reset}
  Model: ${C.yellow}${MODEL}${C.reset}
  Mode:  ${agentMode ? C.green + 'Agent' : C.cyan + 'Chat'}${C.reset}

${C.dim}Commands:  /mode      — toggle chat/agent
          /clear     — clear conversation
          /model     — change model
          /quit      — exit${C.reset}
`)
}

function prompt(): string {
  return `${agentMode ? C.green + 'agent' : C.cyan + 'chat'}${C.reset} > `
}

async function streamChat(userMessage: string) {
  conversationHistory.push({ role: 'user', content: userMessage })

  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...conversationHistory,
  ]

  if (!API_KEY) {
    console.log(`${C.red}Error: DEEPSEEK_API_KEY not set.${C.reset}`)
    console.log(`${C.dim}Set it in .env or use: DEEPSEEK_API_KEY=sk-... npx tsx src/cli.ts${C.reset}`)
    conversationHistory.pop()
    return
  }

  const url = `${BASE_URL}/v1/chat/completions`

  const body: any = {
    model: MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 8192,
    stream: true,
  }

  if (agentMode) {
    body.tools = [
      {
        type: 'function',
        function: {
          name: 'shell_exec',
          description: 'Execute a shell command and return the output',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string', description: 'Shell command to execute' } },
            required: ['command'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web using Bing',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              count: { type: 'number', description: 'Number of results' },
            },
            required: ['query'],
          },
        },
      },
    ]
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const err = await response.text()
      console.log(`${C.red}API Error ${response.status}: ${err.slice(0, 200)}${C.reset}`)
      conversationHistory.pop()
      return
    }

    const reader = response.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''
    let fullContent = ''
    let reasoning = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta
          if (!delta) continue

          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content
            process.stdout.write(`${C.dim}${delta.reasoning_content}${C.reset}`)
          }
          if (delta.content) {
            fullContent += delta.content
            process.stdout.write(delta.content)
          }

          // Handle tool calls in agent mode
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const fn = tc.function
              if (fn?.name) {
                console.log(`\n${C.yellow}[Tool: ${fn.name}]${C.reset}`)
                const args = JSON.parse(fn.arguments || '{}')

                let result = ''
                if (fn.name === 'shell_exec') {
                  const { exec } = await import('child_process')
                  result = await new Promise<string>((resolve) => {
                    exec(args.command, { timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                      resolve(error ? stderr || error.message : stdout)
                    })
                  })
                } else if (fn.name === 'web_search') {
                  const searchUrl = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(args.query)}`
                  const searchResp = await fetch(searchUrl)
                  const xml = await searchResp.text()
                  const items = xml.match(/<title>(?!Web Search)[^<]+/g)?.slice(0, args.count || 5) || []
                  result = items.map(t => t.replace('<title>', '')).join('\n')
                }

                console.log(`${C.dim}${result.slice(0, 500)}${C.reset}\n`)

                // Add tool result to conversation and continue
                conversationHistory.push({
                  role: 'assistant',
                  content: fullContent || '',
                } as any)
                conversationHistory.push({
                  role: 'user' as any,
                  content: `[Tool Result for ${fn.name}]: ${result}`,
                } as any)
                fullContent = ''
              }
            }
          }
        } catch {
          // skip
        }
      }
    }

    console.log() // newline after streaming
    if (fullContent) {
      conversationHistory.push({ role: 'assistant', content: fullContent })
    }
  } catch (err: any) {
    console.log(`${C.red}Error: ${err.message}${C.reset}`)
    conversationHistory.pop()
  }
}

function handleCommand(input: string): boolean {
  const cmd = input.trim().toLowerCase()
  switch (cmd) {
    case '/quit':
    case '/exit':
    case '/q':
      return false
    case '/clear':
      conversationHistory.length = 0
      console.log(`${C.dim}Conversation cleared.${C.reset}`)
      return true
    case '/mode':
      agentMode = !agentMode
      console.log(`Mode: ${agentMode ? C.green + 'Agent' : C.cyan + 'Chat'}${C.reset}`)
      return true
    case '/model':
      console.log(`Current model: ${C.yellow}${MODEL}${C.reset}`)
      return true
    case '/help':
      console.log(`
${C.bold}Commands:${C.reset}
  /mode      Toggle between Chat and Agent mode
  /clear     Clear conversation history
  /model     Show current model
  /quit      Exit
`)
      return true
    default:
      console.log(`${C.dim}Unknown command. Type /help for available commands.${C.reset}`)
      return true
  }
}

async function main() {
  banner()

  if (!API_KEY) {
    console.log(`${C.yellow}Warning: DEEPSEEK_API_KEY not set.${C.reset}`)
    console.log(`${C.dim}Set it in .env: DEEPSEEK_API_KEY=sk-your-key-here${C.reset}\n`)
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: prompt(),
  })

  rl.prompt()

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) {
      rl.prompt()
      return
    }

    if (input.startsWith('/')) {
      const shouldContinue = handleCommand(input)
      if (!shouldContinue) {
        rl.close()
        return
      }
      rl.prompt()
      return
    }

    await streamChat(input)
    rl.prompt()
  })

  rl.on('close', () => {
    console.log(`\n${C.dim}Bye!${C.reset}`)
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
