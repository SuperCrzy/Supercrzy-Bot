// P0: 全局异常处理器，防止任何意外错误导致进程崩溃
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message)
  process.exit(1)
})
process.on('unhandledRejection', (reason: any) => {
  console.error('[unhandledRejection]', reason?.message || reason)
})

import Koa from 'koa'
import cors from '@koa/cors'
import bodyParser from 'koa-bodyparser'
import serve from 'koa-static'
import { createServer } from 'http'
import { config } from './config'
import { initDatabase } from './services/database'
import { createTerminalServer } from './services/terminal'
import { startTunnel, stopTunnel, renderPreviewPage, getTunnelUrl, createPreviewLink } from './services/tunnel'
import { chatRouter } from './routes/chat'
import { fsRouter } from './routes/filesystem'
import { settingsRouter } from './routes/settings'
import { sessionRouter } from './routes/session'
import { historyRouter } from './routes/history'
import { statsRouter } from './routes/stats'
import { memoryRouter } from './routes/memory'
import { uploadRouter } from './routes/upload'
import { gatewayRouter, initChannelsTable } from './routes/gateway'
import { startAllTelegramChannels } from './gateway/telegram-bot'
import { startAllDiscordChannels } from './gateway/discord-bot'
import { startAllSlackChannels } from './gateway/slack-bot'
import { startAllDingtalkChannels } from './gateway/dingtalk-bot'
import { startAllFeishuChannels } from './gateway/feishu-bot'
import { startAllWecomChannels } from './gateway/wecom-bot'
import skillsRouter, { seedBuiltinSkills } from './routes/skills'
import { syncFileSkills, initSkillsDirectory } from './services/skill-loader'
import tasksRouter from './routes/tasks'
import automationsRouter from './routes/automations'
import { modelsRouter } from './routes/models'
import { workspaceRouter } from './routes/workspace'
import { ocrRouter } from './routes/ocr'
import checkpointsRouter from './routes/checkpoints'
import { playbookRouter } from './routes/playbook'
import { rolesRouter } from './routes/roles'
import { systemRouter } from './routes/system'
import { collabRouter } from './routes/collab'
import { recoverInterruptedTasks } from './services/collab-engine'
import { newsRouter } from './routes/news'
import { terminalRouter } from './routes/terminal'
import { startScheduler } from './services/scheduler'
import { loadCredentials, sendMessage } from './services/wechat-ilink'
import { startBot, setMessageHandlerFull } from './services/wechat-bot-runner'
import { QQBotRunner } from './services/qqbot-runner'
import { getDB } from './services/database'
import { randomUUID } from 'crypto'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { join, relative, dirname, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import os from 'os'
import { stopComputerUse } from './services/computer-use'
import { mcpRouter } from './routes/mcp'
import { routineRouter } from './routes/routines'
import { stopAllMcp } from './services/mcp-manager'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const WORKSPACE_ROOT = config.workspaceDir || process.cwd()

function getLocalIP(): string {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return ''
}

async function bootstrap() {
  initDatabase()
  initChannelsTable()
  seedBuiltinSkills()
  initSkillsDirectory(process.cwd())
  syncFileSkills(process.cwd())
  startScheduler()

  const app = new Koa()
  const PORT = config.port

  // Auto-start WeChat bot if credentials exist
  const creds = loadCredentials()
  
  // ---- 流式进度通知器 ----
  function sendProgressMsg(userId: string, ctxToken: string, msg: string): void {
    if (!creds || !ctxToken) return
    sendMessage(creds.baseUrl, creds.token, userId, msg, ctxToken).catch((err: any) =>
      console.warn('[WeChat Progress] Send failed:', err.message)
    )
  }
  
  // 工具名中文映射
  const toolNameMap: Record<string, string> = {
    read_file: '读取文件', read_multiple_files: '批量读取文件',
    write_to_file: '写入文件', edit_file: '编辑文件',
    bash: '执行命令', search_files: '搜索文件',
    glob: '查找文件', ask_followup_question: '提问',
    web_search: '网络搜索', web_fetch: '网页抓取',
    task_create: '创建任务', task_update: '更新任务',
    // Agent 工具名（来自 agent.ts / tools.ts）
    file_read: '读取文件', file_write: '写入文件', file_exists: '检查文件',
    shell_exec: '执行命令',
    memory_store: '保存记忆', memory_recall: '回忆记忆', memory_list: '列出记忆', memory_consolidate: '合并记忆',
    skill_list: '列出技能', skill_search: '搜索技能', skill_view: '查看技能', skill_install: '安装技能',
  }

  // 需要显示进度的高价值工具（写操作、搜索等），查询类工具静默不发
  const progressTools: Record<string, true> = {
    file_write: true, write_to_file: true, edit_file: true,
    web_search: true, web_fetch: true,
    memory_store: true, skill_install: true,
    shell_exec: true, task_create: true, task_update: true,
  }

  // 根据工具意图生成用户可读的进度描述，查询类工具返回空串（不发通知）
  function getToolDescription(tc: { name?: string; arguments?: string }): string {
    const name = tc.name || ''
    if (!progressTools[name]) return ''  // 查询类工具静默
    if (!tc.arguments) return toolNameMap[name] || name
    try {
      const args = JSON.parse(tc.arguments)
      if (name === 'file_write' || name === 'write_to_file' || name === 'edit_file') {
        const fp = args.path || args.file_path || args.filePath || ''
        const fn = fp.split('/').pop() || fp
        return '📝 正在生成: ' + fn
      }
      if (name === 'web_search') {
        const q = (args.query || '').slice(0, 30)
        return q ? '🔍 搜索: ' + q : '🔍 正在搜索...'
      }
      if (name === 'web_fetch') {
        const u = (args.url || '').replace(/https?:\/\//, '').slice(0, 30)
        return u ? '📖 阅读: ' + u : '📖 正在获取网页...'
      }
      if (name === 'memory_store') {
        const k = (args.key || '').slice(0, 30)
        return k ? '🧠 已记住: ' + k : '🧠 正在保存记忆...'
      }
      if (name === 'skill_install') {
        return '🔧 正在安装技能...'
      }
      if (name === 'shell_exec') {
        const cmd: string = args.command || ''
        if (cmd.includes('npm install') || cmd.includes('pip install') || cmd.includes('yarn add')) return '📦 安装依赖中...'
        if (cmd.includes('npm run') || cmd.includes('pnpm') || cmd.includes('yarn run')) return '⚡ 运行脚本中...'
        if (cmd.includes('git clone') || cmd.includes('git pull') || cmd.includes('git fetch')) return '🔄 同步代码中...'
        if (cmd.includes('git ')) return '🔄 Git 操作中...'
        const qt = cmd.trim(); if (qt.startsWith('cd') || qt === 'ls' || qt.startsWith('ls ') || qt.startsWith('cat ') || qt.startsWith('grep ') || qt.startsWith('find ') || qt === 'pwd' || qt.startsWith('echo ') || qt === 'which' || qt.startsWith('which ') || qt.startsWith('node ') || qt.startsWith('python') || qt.startsWith('tsx ') || qt.startsWith('cp ') || qt.startsWith('mv ') || qt.startsWith('rm ') || qt.startsWith('chmod ') || qt.startsWith('mkdir') || qt.startsWith('touch ')) return ''
        if (cmd.includes('curl') || cmd.includes('wget')) return '⬇️ 下载文件中...'
        
        return '⚙️ 执行系统操作...'
      }
      return toolNameMap[name] || name
    } catch { return toolNameMap[name] || name }
  }

  if (creds) {
    const db = getDB()
    setMessageHandlerFull(async (_userId, text, sessionId, contextToken) => {
      console.log(`[WeChat Handler] START - userId=${_userId.slice(0,8)}, text=${text.slice(0,20)}`)

      try {
        // Ensure session exists
        const existingSession = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)
        if (!existingSession) {
          db.prepare("INSERT INTO sessions (id, title, model) VALUES (?, ?, ?)").run(
            sessionId, `WeChat: ${_userId.slice(0, 12)}...`, 'deepseek-v4-pro'
          )
        }

        // Store user message
        const userMsgId = randomUUID()
        db.prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)").run(
          userMsgId, sessionId, 'user', text
        )
        console.log(`[WeChat Handler] DB done, calling agent...`)
        
        // 立即发送"正在思考"提示

        // Get recent history for context
        const history = db.prepare(
          "SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 30"
        ).all(sessionId) as Array<{ role: string; content: string }>
        const apiMessages = history.reverse().map(m => ({ role: m.role, content: m.content }))

        // 解析续跑命令
        let resumeCheckpoint: string | undefined = undefined
        const resumeMatch = text.match(/(?:继续检查点|resume checkpoint)\s+([a-f0-9-]+)/i)
        if (resumeMatch) {
          const ckptId = resumeMatch[1]
          const ckptPath = join(process.cwd(), 'data', 'checkpoints', `${ckptId}.json`)
          const { existsSync } = await import('fs')
          if (existsSync(ckptPath)) {
            resumeCheckpoint = ckptPath
            sendProgressMsg(_userId, contextToken, `从检查点恢复: ${ckptId.slice(0, 8)}...`)
            console.log(`[WeChat Handler] Resuming checkpoint: ${ckptId}`)
          } else {
            console.log(`[WeChat Handler] Checkpoint file not found: ${ckptPath}`)
          }
        }

        // Call Agent with history - 超时 8 分钟
        let heartbeatInterval: NodeJS.Timeout | null = null
        const controller = new AbortController()
        // 从 settings 读取超时，默认 8 分钟
        const gatewayTimeoutRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('gatewayTimeout') as any
        const gatewayTimeoutMs = (gatewayTimeoutRow ? parseInt(gatewayTimeoutRow.value) || 480 : 480) * 1000
        const timeout = setTimeout(() => controller.abort(), gatewayTimeoutMs)
        try {
          const currentModel = (db.prepare('SELECT value FROM settings WHERE key = ?').get('model') as any)?.value || 'deepseek-v4-pro'
          const body: any = { messages: apiMessages, model: currentModel }
          if (resumeCheckpoint) body.resumeCheckpoint = resumeCheckpoint
          const res = await fetch(`http://localhost:${PORT}/api/chat/agent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          clearTimeout(timeout)
          console.log(`[WeChat Handler] Agent response status: ${res.status}`)
          if (!res.ok) return 'Agent is busy, try later.'
          const reader = res.body?.getReader()
          if (!reader) return ''
          
          const decoder = new TextDecoder()
          let buf = ''
          let result = ''
          let hasFile = false
          let filePath = ''
          let lastToolName = ''
          let checkpointCount = 0
          let currentEvent = ''

          // 心跳：每 60 秒通知一次，同时作为流超时检测
          let lastStreamActivity = Date.now()
          heartbeatInterval = setInterval(() => {
            const idle = Date.now() - lastStreamActivity
            console.log(`[WeChat Handler] Heartbeat... idle=${Math.round(idle/1000)}s`)
            // 流超过 3 分钟无数据，视为卡死
            if (idle > 180000) {
              console.log('[WeChat Handler] Stream idle too long, aborting')
              controller.abort()
            }
          }, 30000)
          
          while (true) {
            // 每次 read 加 60 秒超时，防止永久阻塞
            const readPromise = reader.read()
            const timeoutPromise = new Promise<{ done: boolean; value: undefined }>((resolve) =>
              setTimeout(() => resolve({ done: true, value: undefined }), 60000)
            )
            const { done, value } = await Promise.race([readPromise, timeoutPromise])
            if (done) {
              if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null }
              break
            }
            lastStreamActivity = Date.now()
            buf += decoder.decode(value, { stream: true })
            
            // 解析 SSE 行
            const lines = buf.split('\n')
            buf = lines.pop() || ''
            
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim()
                continue
              }
              if (!line.startsWith('data: ')) continue
              try {
                const d = JSON.parse(line.slice(6))
                const now = Date.now()
                
                // ---- 进度追踪（仅日志，不消耗 contextToken 配额） ----
                if (currentEvent === 'tool_call') {
                  lastToolName = d.name || ''
                  const desc = getToolDescription({ name: d.name, arguments: d.arguments })
                  if (desc) console.log(`[Agent Tool] ${desc}`)
                } else if (currentEvent === 'file_created') {
                  const fname = d.name || d.path || '未知'
                  console.log(`[Agent File] ${fname}`)
                  if (d.path) { hasFile = true; filePath = d.path }
                }
                
                // 收集最终结果：content_chunk 累积为主，content 仅在更完整时覆盖
                if (currentEvent === 'content_chunk' && d.text) {
                  result = result || ''
                  result += d.text
                }
                if (currentEvent === "content" && typeof d.content === 'string' && d.content && d.content.length > result.length) result = d.content
                if (currentEvent === 'done' && d.summary && !result) result = d.summary
              } catch {}
            }
          }
          if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null }
          console.log(`[WeChat Handler] Stream done, result length: ${result.length}`)

          // Store assistant reply & 发送最终结果给用户
          const msgId = randomUUID()
          let fullResult = result || '任务已完成，无文字输出。'
          if (hasFile && filePath) {
            const previewUrl = createPreviewLink(filePath)
            fullResult += `\n\n产物: ${filePath}\n手机预览: ${previewUrl}`
          }
          db.prepare("INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, ?, ?)").run(
            msgId, sessionId, 'assistant', fullResult
          )
          console.log(`[WeChat Handler] COMPLETE`)

          // 全文返回，分段由 processMessage 统一处理
          return fullResult
        } catch (err: any) {
          clearTimeout(timeout)
          if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null }
          console.error(`[WeChat Handler] Error:`, err.message)
          sendProgressMsg(_userId, contextToken, `出错: ${err.message?.slice(0, 80) || '未知错误'}`)
          return '抱歉，处理消息时出错。'
        }
      } catch (err: any) {
        console.error(`[WeChat Handler] Outer error:`, err.message)
        sendProgressMsg(_userId, contextToken, '服务暂时不可用，请稍后重试。')
        return '抱歉，服务暂时不可用。'
      }
    })
    startBot(async (_userId, text) => '')
      .then(r => console.log('[Bootstrap] WeChat bot:', r.success ? 'started' : r.error))
  }

  // ---- QQ Bot ----
  const qqDb = getDB()
  const qqAppId = process.env.QQ_APPID || (qqDb.prepare("SELECT value FROM settings WHERE key = 'qqAppId'").get() as any)?.value
  const qqSecret = process.env.QQ_APPSECRET || (qqDb.prepare("SELECT value FROM settings WHERE key = 'qqAppSecret'").get() as any)?.value
  if (qqAppId && qqSecret) {
    for (const [k, v] of [['qqAppId', qqAppId], ['qqAppSecret', qqSecret]] as [string, string][]) {
      if (!qqDb.prepare("SELECT key FROM settings WHERE key = ?").get(k)) {
        qqDb.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(k, v)
      } else {
        qqDb.prepare("UPDATE settings SET value = ? WHERE key = ?").run(v, k)
      }
    }

    const INTENTS = (1 << 25) | (1 << 30) | (1 << 12)
    const qqRunner = new QQBotRunner({
      appId: qqAppId, appSecret: qqSecret,
      intents: INTENTS, agentPort: PORT,
    })

    qqRunner.start().catch((err: any) => {
      console.error('[Bootstrap] QQ Bot start failed:', err.message)
    })
    console.log('[Bootstrap] QQ Bot: starting')
  } else {
    console.log('[Bootstrap] QQ Bot: no credentials configured')
  }

  // CORS 白名单（默认仅本地，可用 CORS_ORIGINS 逗号分隔扩展）
  const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000')
    .split(',').map((s: string) => s.trim()).filter(Boolean)
  app.use(cors({
    origin: (ctx) => {
      const origin = ctx.request.header.origin
      if (!origin) return '*'
      return allowedOrigins.includes(origin) ? origin : ''
    },
  }))
  app.use(bodyParser())

  // API 鉴权：配置访问令牌后，非本地来源的 /api 请求需 Authorization: Bearer <token>
  // 令牌来源：settings 表 accessToken（设置页生成，优先）|| 环境变量 API_TOKEN（兜底）
  app.use(async (ctx, next) => {
    let API_TOKEN = process.env.API_TOKEN || ''
    try {
      const row = getDB().prepare("SELECT value FROM settings WHERE key = 'accessToken'").get() as { value: string } | undefined
      if (row?.value) API_TOKEN = row.value
    } catch { /* DB 未初始化时跳过 */ }
    if (!API_TOKEN || !ctx.path.startsWith('/api/') || ctx.path === '/api/health') return next()
    const origin = ctx.request.header.origin || ''
    const isLocal = !origin || origin.includes('localhost') || origin.includes('127.0.0.1')
    if (isLocal) return next()
    if (ctx.request.header.authorization !== `Bearer ${API_TOKEN}`) {
      ctx.status = 401
      ctx.body = { error: 'Unauthorized: invalid or missing API token' }
      return
    }
    return next()
  })

  // 托管前端构建产物：dev 在 ../../client/dist；打包后（electron-builder extraResources）在 Resources/client-dist
  const distCandidates = [
    join(__dirname, '../../client/dist'),        // dev（monorepo：server/src → packages/client/dist）
    join(__dirname, '../../../../client-dist'),  // 打包（Resources/backend/packages/server/src → Resources/client-dist）
  ]
  const distPath = distCandidates.find((p) => existsSync(join(p, 'index.html'))) || distCandidates[0]
  if (existsSync(distPath)) {
    app.use(serve(distPath))
    console.log(`[static] Serving frontend from ${distPath}`)
  }

  // API Routes
  const routers = [uploadRouter, chatRouter, fsRouter, settingsRouter, sessionRouter, historyRouter, statsRouter, memoryRouter, gatewayRouter, skillsRouter, tasksRouter, automationsRouter, modelsRouter, workspaceRouter, ocrRouter, checkpointsRouter, playbookRouter, rolesRouter, systemRouter, collabRouter, newsRouter, mcpRouter, routineRouter, terminalRouter]
  for (const r of routers) {
    app.use(r.routes())
    app.use(r.allowedMethods())
  }

  // Health check
  app.use(async (ctx) => {
    if (ctx.path === '/api/health') {
      ctx.body = { status: 'ok', model: config.deepseek.defaultModel, uptime: process.uptime(), tunnel: getTunnelUrl() || 'offline' }
      return
    }
    // 文件预览（安全加固：仅允许白名单目录内文件，防任意文件读取）
    if (ctx.path.startsWith('/api/preview/')) {
      let filePath = decodeURIComponent(ctx.path.slice('/api/preview/'.length))
      let absPath = filePath.startsWith('/') ? filePath : join(WORKSPACE_ROOT, filePath)
      absPath = resolve(absPath)
      // 白名单：必须在工作区或 uploads 内
      const allowedRoots = [resolve(WORKSPACE_ROOT), resolve(join(WORKSPACE_ROOT, 'uploads'))]
      const inside = allowedRoots.some((root) => absPath === root || absPath.startsWith(root + sep))
      if (!inside) { ctx.status = 403; ctx.body = 'Forbidden: outside allowed workspace'; return }
      // 拒绝敏感文件（凭据/数据库/密钥/日志/git 内部）
      if (/(^|\/)\.[^/]+|\.(env|key|pem|db|db-wal|db-shm|log|tsbuildinfo)$/.test(absPath)) {
        ctx.status = 403; ctx.body = 'Forbidden: sensitive file type'; return
      }
      if (!existsSync(absPath)) {
        const fallback = join(WORKSPACE_ROOT, filePath.split('/').pop() || '')
        if (resolve(fallback) !== absPath || !existsSync(fallback)) { ctx.status = 404; ctx.body = `File not found: ${filePath}`; return }
        absPath = fallback
      }
      const content = readFileSync(absPath, 'utf-8')
      ctx.type = 'html'
      ctx.body = renderPreviewPage(filePath, content)
      return
    }
    // SPA fallback
    if (ctx.method === 'GET' && !ctx.path.startsWith('/api/')) {
      const indexPath = join(distPath, 'index.html')
      if (existsSync(indexPath)) {
        ctx.type = 'html'
        ctx.body = readFileSync(indexPath, 'utf-8')
      }
    }
  })

  const server = createServer(app.callback())

  // 2026-09-01 超级协作平台：重启时把未完成串行任务标记为"进程中断"（可恢复提示）
  // （collab-engine 导入）

  // Terminal WebSocket
  createTerminalServer(server)

  // Cloudflare Tunnel（默认关闭，TUNNEL_ENABLED=true 才开启）
  const tunnelSubdomain = process.env.TUNNEL_SUBDOMAIN || config.tunnel.subdomain
  if (config.tunnel.enabled) {
    startTunnel(PORT).catch((err: any) => {
      console.warn('[Tunnel] Failed to start:', err.message)
    })
  }

  server.listen(PORT, () => {
    const localIP = getLocalIP()
    console.log(`\n🚀 SUPERCRZY BOT running on:`)
    console.log(`   Local:   http://localhost:${PORT}`)
    if (localIP) console.log(`   Network: http://${localIP}:${PORT}`)
    if (getTunnelUrl()) console.log(`   Tunnel:  ${getTunnelUrl()}`)
    console.log(`   Workspace: ${WORKSPACE_ROOT}\n`)

    // 超级协作平台：重启后标记上次未完成任务为"进程中断"（可恢复提示）
    recoverInterruptedTasks()

    // 恢复已启用的各平台通道（常驻后台）
    startAllTelegramChannels().catch((err: any) => {
      console.error('[Bootstrap] Telegram channels restore failed:', err.message)
    })
    startAllDiscordChannels().catch((err: any) => {
      console.error('[Bootstrap] Discord channels restore failed:', err.message)
    })
    startAllSlackChannels().catch((err: any) => {
      console.error('[Bootstrap] Slack channels restore failed:', err.message)
    })
    startAllDingtalkChannels().catch((err: any) => {
      console.error('[Bootstrap] Dingtalk channels restore failed:', err.message)
    })
    startAllFeishuChannels().catch((err: any) => {
      console.error('[Bootstrap] Feishu channels restore failed:', err.message)
    })
    startAllWecomChannels().catch((err: any) => {
      console.error('[Bootstrap] Wecom channels restore failed:', err.message)
    })
  })

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Shutdown] SIGINT received')
    await stopTunnel()
    stopComputerUse()
    stopAllMcp()
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    console.log('\n[Shutdown] SIGTERM received')
    await stopTunnel()
    stopComputerUse()
    stopAllMcp()
    process.exit(0)
  })
}

bootstrap().catch((err) => {
  console.error('[Bootstrap] Fatal error:', err)
  process.exit(1)
})
