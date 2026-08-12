/**
 * SuperCrzy CLI
 * 终端对话工具 — 直接在命令行中与 SuperCrzy 对话
 *
 * 用法: pnpm cli
 *
 * 配置:
 *   - 首次启动自动引导设置 API Key
 *   - /config 命令随时修改配置
 *   - 与 Web UI 共享 SQLite settings 表，双向同步
 */
import * as readline from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import { config } from './config/index.js'
import { initDatabase, getDB } from './services/database.js'

// ─── Types ───────────────────────────────────────────────
interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface CliSettings {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  systemPrompt: string
}

// ─── State ───────────────────────────────────────────────
const conversationHistory: Message[] = []
let agentMode = false
let cliSettings: CliSettings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  temperature: 0.7,
  maxTokens: 8192,
  systemPrompt: 'You are SuperCrzy, a helpful AI assistant. Answer in the same language the user uses. Be concise and practical.',
}

// ─── ANSI Colors ─────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  magenta: '\x1b[35m',
}

// ─── Settings Persistence (SQLite) ───────────────────────
function loadSettingsFromDB(): CliSettings {
  try {
    const db = getDB()
    const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>
    const raw: Record<string, string> = {}
    for (const row of rows) {
      raw[row.key] = row.value
    }

    return {
      apiKey: raw.apiKey || config.deepseek.apiKey || '',
      baseUrl: raw.baseUrl || config.deepseek.baseUrl || 'https://api.deepseek.com',
      model: raw.model || config.deepseek.defaultModel || 'deepseek-v4-pro',
      temperature: parseFloat(raw.temperature || '0.7'),
      maxTokens: parseInt(raw.maxTokens || '8192', 10),
      systemPrompt: raw.systemPrompt || cliSettings.systemPrompt,
    }
  } catch {
    // DB not initialized yet, fall back to env/config
    return {
      apiKey: config.deepseek.apiKey || '',
      baseUrl: config.deepseek.baseUrl || 'https://api.deepseek.com',
      model: config.deepseek.defaultModel || 'deepseek-v4-pro',
      temperature: 0.7,
      maxTokens: 8192,
      systemPrompt: cliSettings.systemPrompt,
    }
  }
}

function saveSettingsToDB(settings: Partial<CliSettings>) {
  const db = getDB()
  const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))")
  if (settings.apiKey !== undefined) stmt.run('apiKey', settings.apiKey)
  if (settings.baseUrl !== undefined) stmt.run('baseUrl', settings.baseUrl)
  if (settings.model !== undefined) stmt.run('model', settings.model)
  if (settings.temperature !== undefined) stmt.run('temperature', String(settings.temperature))
  if (settings.maxTokens !== undefined) stmt.run('maxTokens', String(settings.maxTokens))
  if (settings.systemPrompt !== undefined) stmt.run('systemPrompt', settings.systemPrompt)
}

// ─── Banner & Prompt ─────────────────────────────────────
function banner() {
  const modelDisplay = cliSettings.model || 'not set'
  const keyStatus = cliSettings.apiKey
    ? `${C.green}●${C.reset} Connected`
    : `${C.red}●${C.reset} No API Key`

  console.log(`
${C.cyan}${C.bold}╔══════════════════════════════════════════╗
║       SuperCrzy — CLI Mode          ║
╚══════════════════════════════════════════╝${C.reset}
  Model:    ${C.yellow}${modelDisplay}${C.reset}
  API Key:  ${keyStatus}
  Mode:     ${agentMode ? C.green + 'Agent' : C.cyan + 'Chat'}${C.reset}

${C.dim}Commands:  /mode      — toggle chat/agent
          /config    — configure settings
          /model     — show / change model
          /clear     — clear conversation
          /status    — show current config
          /help      — show all commands
          /quit      — exit${C.reset}
`)
}

function promptStr(): string {
  return `${agentMode ? C.green + 'agent' : C.cyan + 'chat'}${C.reset} > `
}

// ─── Setup Wizard ────────────────────────────────────────
function ask(rl: readline.Interface, question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const display = defaultValue ? `${C.cyan}${question}${C.reset} ${C.dim}[${defaultValue}]${C.reset}: ` : `${C.cyan}${question}${C.reset}: `
    rl.question(display, (answer) => {
      resolve(answer.trim() || defaultValue || '')
    })
  })
}

async function runSetupWizard(rl: readline.Interface): Promise<boolean> {
  console.log(`\n${C.yellow}${C.bold}⚡ Welcome to SuperCrzy!${C.reset}`)
  console.log(`${C.dim}Let's set up your configuration to get started.${C.reset}\n`)

  // Step 1: API Key
  console.log(`${C.bold}Step 1/3: API Key${C.reset}`)
  console.log(`${C.dim}Get your key at: https://platform.deepseek.com/api_keys${C.reset}`)
  const apiKey = await ask(rl, 'Enter your API Key')

  if (!apiKey) {
    console.log(`\n${C.yellow}No API Key provided. You can configure it later with ${C.cyan}/config${C.yellow}.${C.reset}`)
    console.log(`${C.dim}The CLI will run in demo mode until an API Key is set.${C.reset}\n`)
    return false
  }

  // Validate key format
  if (!apiKey.startsWith('sk-')) {
    console.log(`\n${C.yellow}⚠ Key doesn't look like a standard API key (should start with "sk-").${C.reset}`)
    const confirm = await ask(rl, 'Use this key anyway?', 'y')
    if (confirm.toLowerCase() !== 'y') {
      console.log(`${C.dim}Setup cancelled.${C.reset}\n`)
      return false
    }
  }

  cliSettings.apiKey = apiKey

  // Step 2: Model
  console.log(`\n${C.bold}Step 2/3: Model${C.reset}`)
  console.log(`${C.dim}Available models:${C.reset}`)
  console.log(`  ${C.cyan}1${C.reset}) deepseek-chat      ${C.gray}(fast, cost-effective)${C.reset}`)
  console.log(`  ${C.cyan}2${C.reset}) deepseek-reasoner  ${C.gray}(deep thinking)${C.reset}`)
  console.log(`  ${C.cyan}3${C.reset}) deepseek-v4-pro    ${C.gray}(latest, most capable)${C.reset}`)
  const modelChoice = await ask(rl, 'Select model', '3')

  const modelMap: Record<string, string> = {
    '1': 'deepseek-chat',
    '2': 'deepseek-reasoner',
    '3': 'deepseek-v4-pro',
  }
  cliSettings.model = modelMap[modelChoice] || modelChoice || 'deepseek-v4-pro'

  // Step 3: Base URL
  console.log(`\n${C.bold}Step 3/3: API Endpoint${C.reset}`)
  const baseUrl = await ask(rl, 'API Base URL', 'https://api.deepseek.com')
  cliSettings.baseUrl = baseUrl || 'https://api.deepseek.com'

  // Save to DB
  saveSettingsToDB(cliSettings)

  // Test connection
  console.log(`\n${C.dim}Testing connection...${C.reset}`)
  const ok = await testApiConnection()
  if (ok) {
    console.log(`${C.green}${C.bold}✅ Setup complete! Connection successful.${C.reset}`)
  } else {
    console.log(`${C.yellow}⚠ Connection test failed. You can retry with /config.${C.reset}`)
  }

  console.log('')
  return true
}

// ─── Config Menu ─────────────────────────────────────────
async function runConfigMenu(rl: readline.Interface) {
  console.log(`\n${C.cyan}${C.bold}⚙ Configuration${C.reset}`)
  console.log(`${C.dim}────────────────────────────────────${C.reset}`)
  console.log(`  ${C.cyan}1${C.reset}) API Key      ${C.gray}${maskKey(cliSettings.apiKey)}${C.reset}`)
  console.log(`  ${C.cyan}2${C.reset}) Model        ${C.gray}${cliSettings.model}${C.reset}`)
  console.log(`  ${C.cyan}3${C.reset}) Base URL     ${C.gray}${cliSettings.baseUrl}${C.reset}`)
  console.log(`  ${C.cyan}4${C.reset}) Temperature  ${C.gray}${cliSettings.temperature}${C.reset}`)
  console.log(`  ${C.cyan}5${C.reset}) Max Tokens   ${C.gray}${cliSettings.maxTokens}${C.reset}`)
  console.log(`  ${C.cyan}6${C.reset}) System Prompt${C.gray}${cliSettings.systemPrompt.length > 40 ? cliSettings.systemPrompt.slice(0, 40) + '...' : cliSettings.systemPrompt}${C.reset}`)
  console.log(`  ${C.cyan}7${C.reset}) Test Connection`)
  console.log(`  ${C.cyan}0${C.reset}) Back to chat`)
  console.log('')

  const choice = await ask(rl, 'Select option')

  switch (choice) {
    case '1': {
      const key = await ask(rl, 'Enter new API Key (empty to skip)')
      if (key) {
        cliSettings.apiKey = key
        saveSettingsToDB({ apiKey: key })
        console.log(`${C.green}✅ API Key updated.${C.reset}`)
      }
      break
    }
    case '2': {
      console.log(`${C.dim}Available: deepseek-chat, deepseek-reasoner, deepseek-v4-pro${C.reset}`)
      const model = await ask(rl, 'Enter model name', cliSettings.model)
      if (model) {
        cliSettings.model = model
        saveSettingsToDB({ model })
        console.log(`${C.green}✅ Model set to: ${model}${C.reset}`)
      }
      break
    }
    case '3': {
      const url = await ask(rl, 'Enter Base URL', cliSettings.baseUrl)
      if (url) {
        cliSettings.baseUrl = url
        saveSettingsToDB({ baseUrl: url })
        console.log(`${C.green}✅ Base URL updated.${C.reset}`)
      }
      break
    }
    case '4': {
      const temp = await ask(rl, 'Enter temperature (0-2)', String(cliSettings.temperature))
      if (temp) {
        const val = parseFloat(temp)
        if (!isNaN(val) && val >= 0 && val <= 2) {
          cliSettings.temperature = val
          saveSettingsToDB({ temperature: val })
          console.log(`${C.green}✅ Temperature set to: ${val}${C.reset}`)
        } else {
          console.log(`${C.red}Invalid value. Must be 0-2.${C.reset}`)
        }
      }
      break
    }
    case '5': {
      const tokens = await ask(rl, 'Enter max tokens', String(cliSettings.maxTokens))
      if (tokens) {
        const val = parseInt(tokens, 10)
        if (!isNaN(val) && val > 0) {
          cliSettings.maxTokens = val
          saveSettingsToDB({ maxTokens: val })
          console.log(`${C.green}✅ Max tokens set to: ${val}${C.reset}`)
        } else {
          console.log(`${C.red}Invalid value.${C.reset}`)
        }
      }
      break
    }
    case '6': {
      console.log(`${C.dim}Current system prompt: ${C.reset}`)
      console.log(cliSettings.systemPrompt)
      console.log('')
      const newPrompt = await ask(rl, 'Enter new system prompt (empty to skip)')
      if (newPrompt) {
        cliSettings.systemPrompt = newPrompt
        saveSettingsToDB({ systemPrompt: newPrompt })
        console.log(`${C.green}✅ System prompt updated.${C.reset}`)
      }
      break
    }
    case '7': {
      console.log(`${C.dim}Testing connection...${C.reset}`)
      await testApiConnection()
      break
    }
    case '0':
      console.log('')
      return
    default:
      console.log(`${C.dim}Invalid option.${C.reset}`)
  }
}

// ─── Connection Test ─────────────────────────────────────
async function testApiConnection(): Promise<boolean> {
  if (!cliSettings.apiKey) {
    console.log(`${C.red}❌ No API Key configured.${C.reset}`)
    return false
  }

  try {
    const response = await fetch(`${cliSettings.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cliSettings.apiKey}`,
      },
      body: JSON.stringify({
        model: cliSettings.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 5,
        temperature: 0,
        stream: false,
      }),
    })

    if (response.ok) {
      console.log(`${C.green}✅ Connection successful!${C.reset}`)
      return true
    } else {
      const err = await response.text()
      console.log(`${C.red}❌ Connection failed (${response.status}): ${err.slice(0, 200)}${C.reset}`)
      return false
    }
  } catch (err: any) {
    console.log(`${C.red}❌ Network error: ${err.message}${C.reset}`)
    return false
  }
}

// ─── Status Display ──────────────────────────────────────
function showStatus() {
  console.log(`\n${C.cyan}${C.bold}📊 Current Configuration${C.reset}`)
  console.log(`${C.dim}────────────────────────────────────${C.reset}`)
  console.log(`  API Key:    ${cliSettings.apiKey ? C.green + maskKey(cliSettings.apiKey) + C.reset : C.red + '(not set)' + C.reset}`)
  console.log(`  Model:      ${C.yellow}${cliSettings.model}${C.reset}`)
  console.log(`  Base URL:   ${cliSettings.baseUrl}`)
  console.log(`  Temperature: ${cliSettings.temperature}`)
  console.log(`  Max Tokens: ${cliSettings.maxTokens}`)
  console.log(`  Mode:       ${agentMode ? C.green + 'Agent' + C.reset : C.cyan + 'Chat' + C.reset}`)
  console.log(`  DB:         ${config.db.path}`)
  console.log('')
}

// ─── Chat Streaming ──────────────────────────────────────
async function streamChat(userMessage: string) {
  conversationHistory.push({ role: 'user', content: userMessage })

  const messages: Message[] = [
    { role: 'system', content: cliSettings.systemPrompt },
    ...conversationHistory,
  ]

  if (!cliSettings.apiKey) {
    console.log(`\n${C.red}❌ API Key not configured.${C.reset}`)
    console.log(`${C.dim}Run ${C.cyan}/config${C.dim} to set up your API Key.${C.reset}`)
    conversationHistory.pop()
    return
  }

  const url = `${cliSettings.baseUrl}/v1/chat/completions`

  const body: any = {
    model: cliSettings.model,
    messages,
    temperature: cliSettings.temperature,
    max_tokens: cliSettings.maxTokens,
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
        Authorization: `Bearer ${cliSettings.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const err = await response.text()
      console.log(`\n${C.red}API Error ${response.status}: ${err.slice(0, 200)}${C.reset}`)
      conversationHistory.pop()
      return
    }

    const reader = response.body?.getReader()
    if (!reader) return

    const decoder = new TextDecoder()
    let buffer = ''
    let fullContent = ''

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
    console.log(`\n${C.red}Error: ${err.message}${C.reset}`)
    conversationHistory.pop()
  }
}

// ─── Command Handler ─────────────────────────────────────
function handleCommand(input: string): boolean {
  const trimmed = input.trim()
  const cmd = trimmed.toLowerCase().split(' ')[0]

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
      console.log(`Mode: ${agentMode ? C.green + 'Agent (with tools)' : C.cyan + 'Chat'}${C.reset}`)
      return true
    case '/model':
      console.log(`Current model: ${C.yellow}${cliSettings.model}${C.reset}`)
      return true
    case '/status':
      showStatus()
      return true
    case '/help':
      console.log(`
${C.bold}Commands:${C.reset}
  ${C.cyan}/mode${C.reset}       Toggle between Chat and Agent mode
  ${C.cyan}/config${C.reset}     Open configuration menu
  ${C.cyan}/model${C.reset}      Show current model
  ${C.cyan}/status${C.reset}     Show full configuration
  ${C.cyan}/clear${C.reset}      Clear conversation history
  ${C.cyan}/help${C.reset}       Show this help message
  ${C.cyan}/quit${C.reset}       Exit CLI
`)
      return true
    case '/config':
    case '/settings':
    case '/setup':
      // Handled separately due to async
      return true
    default:
      console.log(`${C.dim}Unknown command: ${trimmed}. Type /help for available commands.${C.reset}`)
      return true
  }
}

// ─── Helpers ─────────────────────────────────────────────
function maskKey(key: string): string {
  if (!key || key.length < 12) return '••••••••'
  return key.slice(0, 8) + '••••' + key.slice(-4)
}

// ─── Main ────────────────────────────────────────────────
async function main() {
  // Initialize database
  try {
    initDatabase()
  } catch (err: any) {
    console.error(`${C.red}Failed to initialize database: ${err.message}${C.reset}`)
    process.exit(1)
  }

  // Load settings from DB (synced with Web UI)
  cliSettings = loadSettingsFromDB()

  // Check if first run (no API Key in DB or env)
  const isFirstRun = !cliSettings.apiKey

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  // First-run setup wizard
  if (isFirstRun) {
    await runSetupWizard(rl)
    // Reload after setup
    cliSettings = loadSettingsFromDB()
  }

  banner()

  // Create prompt and start
  rl.setPrompt(promptStr())
  rl.prompt()

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) {
      rl.prompt()
      return
    }

    // Handle commands
    if (input.startsWith('/')) {
      const cmd = input.toLowerCase().split(' ')[0]

      // Async commands that need the rl interface
      if (['/config', '/settings', '/setup'].includes(cmd)) {
        await runConfigMenu(rl)
        console.log('')
        rl.setPrompt(promptStr())
        rl.prompt()
        return
      }

      const shouldContinue = handleCommand(input)
      if (!shouldContinue) {
        rl.close()
        return
      }
      rl.prompt()
      return
    }

    // Chat
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
