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
import { startRelayClient } from './services/relay-client'
import { initDatabase } from './services/database'
import { migrateSearchSettings } from './services/search-settings-migration'
import { startSearxngTunnel, stopSearxngTunnel } from './services/searxng-tunnel'
import { startEventLoopMonitor, getEventLoopStats } from './services/event-loop-lag'
import { getSseStats } from './services/sse-health'
import { createTerminalServer } from './services/terminal'
import { startTunnel, stopTunnel, getTunnelUrl, createPreviewLink } from './services/tunnel'
// TTS 启动预热：手机实测"进程刚起来的第一条朗读"要付冷 TLS 成本（见 warmUpTts 注释）
import { warmUpTts } from './services/tts'
import { pickTtsRoute } from './services/tts-route'
import { accountRouter } from './routes/account'
import { requireAccount, isSignedIn } from './services/account-auth'
import { allowsDevNoAuth, allowsNetworkApi } from './services/network-access'
import { servePreview } from './routes/preview'
import { chatRouter } from './routes/chat'
import { fsRouter } from './routes/filesystem'
import { settingsRouter } from './routes/settings'
import relayRoutes from './routes/relay'
import { sessionRouter, artifactsRouter } from './routes/session'
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
// Same-origin proxy for the site's own pages (used by the app's embedded views).
import { siteRouter } from './routes/site'
import { ttsRouter } from './routes/tts'
import { terminalRouter } from './routes/terminal'
import { bgTasksRouter } from './routes/bg-tasks'
import { startScheduler } from './services/scheduler'
import { loadCredentials, sendMessage } from './services/wechat-ilink'
import { startBot, setMessageHandlerFull } from './services/wechat-bot-runner'
import { QQBotRunner } from './services/qqbot-runner'
import { getDB } from './services/database'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, relative, dirname } from 'path'
import { fileURLToPath } from 'url'

import os from 'os'
import { stopComputerUse } from './services/computer-use'
import { mcpRouter } from './routes/mcp'
import { routineRouter } from './routes/routines'
import { seedPersonalityIfMissing } from './services/personality'
import { personalityRouter } from './routes/personality'
import { diagnoseRouter } from './routes/diagnose'
import { taskStateRouter } from './routes/task-state'
import { persistentGoalsRouter } from './routes/persistent-goals'
import { goalOwnerIsAlive, reconcileDeadGoalRuns } from './services/persistent-goals'
import capabilitiesRouter from './routes/capabilities'
import { restoreFromDB } from './services/task-state'
import { stopAllMcp } from './services/mcp-manager'
import { BROWSER_START_PAGE_PATH, browserStartPageHtml } from './services/ai-browser-start-page'
import { readWechatAgentStream } from './services/wechat-agent-stream'

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
  reconcileDeadGoalRuns(getDB(), goalOwnerIsAlive)
  // Create starter personality files on first boot. Never overwrites: the user may
  // have edited them, and a boot-time rewrite would discard their changes silently.
  try { seedPersonalityIfMissing() } catch (e: any) { console.warn('[personality] seed skipped:', e?.message || e) }
  // Corrects search settings that shipped pointing at an unreachable instance.
  // Runs once per install; see services/search-settings-migration.ts.
  migrateSearchSettings()
  // Keeps an optional SearXNG relay alive when the direct cross-border link is
  // unusable; a no-op unless the searxngTunnel setting is present.
  startSearxngTunnel()
  // 事件循环延迟采样：/api/health 与 /api/system/diagnostics 的客观判据来源（见 services/event-loop-lag.ts）
  startEventLoopMonitor()
  initChannelsTable()
  seedBuiltinSkills()
  initSkillsDirectory(process.cwd())
  syncFileSkills(process.cwd())
  startScheduler()

  const app = new Koa()
  // Mutable: `listenWithFallback` may advance to the next free port when the configured one is
  // taken. Everything downstream reads this binding, so it must reflect the port actually bound.
  let PORT = config.port

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
      console.log('[WeChat Handler] START')

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
        const controller = new AbortController()
        // 从 settings 读取超时，默认 8 分钟
        const gatewayTimeoutRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('gatewayTimeout') as any
        const gatewayTimeoutMs = (gatewayTimeoutRow ? parseInt(gatewayTimeoutRow.value) || 480 : 480) * 1000
        const timeout = setTimeout(() => controller.abort(), gatewayTimeoutMs)
        try {
          const currentModel = (db.prepare('SELECT value FROM settings WHERE key = ?').get('model') as any)?.value || 'deepseek-v4-pro'
          const body: any = { messages: apiMessages, model: currentModel, sessionId }
          if (resumeCheckpoint) body.resumeCheckpoint = resumeCheckpoint
          const res = await fetch(`http://127.0.0.1:${PORT}/api/chat/agent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          console.log(`[WeChat Handler] Agent response status: ${res.status}`)
          if (!res.ok) return '任务未确认完成，请在电脑端检查执行状态。'
          if (!res.body) throw new Error('agent_stream_missing')
          const streamResult = await readWechatAgentStream(res.body, controller, {
            onEvent: (name, data) => {
              if (name === 'tool_call') {
                const desc = getToolDescription({ name: typeof data.name === 'string' ? data.name : '', arguments: typeof data.arguments === 'string' ? data.arguments : '' })
                if (desc) console.log(`[Agent Tool] ${desc}`)
              }
            },
          })
          const result = streamResult.text
          const filePath = streamResult.filePath
          console.log(`[WeChat Handler] Stream ended, result length: ${result.length}`)

          // Store assistant reply & 发送最终结果给用户
          const msgId = randomUUID()
          let fullResult = streamResult.completed ? (result || '任务已完成，无文字输出。') : [result, '任务未确认完成，可能已中断；请在电脑端检查执行状态。'].filter(Boolean).join('\n\n')
          if (filePath) {
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
          console.error(`[WeChat Handler] Error:`, err.message)
          sendProgressMsg(_userId, contextToken, '任务连接中断，请在电脑端检查执行状态。')
          return '任务未确认完成，可能已中断；请在电脑端检查执行状态。'
        } finally { clearTimeout(timeout) }
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
  const syncPushParser = bodyParser({ jsonLimit: '4mb' })
  app.use(async (ctx, next) => {
    if ((ctx.path === '/api/auth-sync/push' || ctx.path === '/api/sessions/import') && ctx.method === 'POST') return syncPushParser(ctx, next)
    return next()
  })
  app.use(bodyParser())

  // API 鉴权：配置访问令牌后，非本地来源的 /api 请求需 Authorization: Bearer <token>
  // 令牌来源：settings 表 accessToken（设置页生成，优先）|| 环境变量 API_TOKEN（兜底）
  app.use(async (ctx, next) => {
    let API_TOKEN = process.env.API_TOKEN || ''
    try {
      const row = getDB().prepare("SELECT value FROM settings WHERE key = 'accessToken'").get() as { value: string } | undefined
      if (row?.value) API_TOKEN = row.value
    } catch { /* DB 未初始化时跳过 */ }
    // `/api/tts/stream` 必须豁免：它由 <audio src> 直接请求，而 **<audio> 标签无法携带
    // 自定义请求头**（带不上 Authorization），照原样判就会让非 localhost 的每次朗读直接 401。
    // 鉴权改由该 URL 上的一次性 token 承担：48 位 hex、TTL 60s、限取 5 次（见 routes/tts.ts）。
    // 同理 `/api/tts/live/stream`（2026-10-21 会话式朗读）也要豁免：它是同一种
    // "<audio src> 直连"，鉴权同样由 48 位 token 承担。
    const ttsStreamPaths = ['/api/tts/stream', '/api/tts/live/stream']
    if (!ctx.path.startsWith('/api/') || ctx.path === '/api/health' || ttsStreamPaths.includes(ctx.path)) return next()
    // S2 fix (2026-11-17 audit): Origin alone is NOT identity. Local = request
    // from a loopback address AND (no Origin, or an Origin exactly on the local
    // allow-list). Substring matching previously let `https://localhost.evil.com`
    // through.
    if (!allowsNetworkApi({
      ip: ctx.ip || '',
      origin: ctx.request.header.origin || '',
      authorization: ctx.request.header.authorization || '',
      apiToken: API_TOKEN,
      port: String(PORT),
    })) {
      ctx.status = 401
      ctx.body = { error: 'Unauthorized: invalid or missing API token' }
      return
    }
    return next()
  })

  // Signed-in gate for every API route. Runs after the network-exposure check
  // above: that one keeps strangers out of a LAN-bound instance, this one keeps
  // the app unusable until an account exists.
  //
  // Local-only bypass, for developing against a source checkout. It needs all
  // three: the operator set the flag, this is not a packaged build, and the
  // request came in over loopback. Sign-in needs a code delivered to an inbox,
  // so without this a machine with no access to that inbox cannot run the app
  // at all — which blocks UI testing of everything behind the gate.
  app.use(async (ctx, next) => {
    if (allowsDevNoAuth({ enabled: process.env.SUPERCRZY_DEV_NO_AUTH, packaged: process.env.SUPERCRZY_PACKAGED,
      remoteAddress: ctx.req.socket.remoteAddress, requestIp: ctx.ip, hostname: ctx.hostname })) return next()
    return requireAccount(ctx, next)
  })

  // AI 浏览器起始页：desktop 的原生视图（WebContentsView）必须先 loadURL 一个**真实 http 页面**
  // 才可能被 attach 模式接管（about:blank / data: 都会被 judgeUrl 挡掉）。
  // 必须挂在 koa-static **之前**：否则会被 SPA 兜底吞掉，URL 是起始页、内容却是 App 界面。
  app.use(async (ctx, next) => {
    if (ctx.path !== BROWSER_START_PAGE_PATH || ctx.method !== 'GET') return next()
    ctx.type = 'html'
    ctx.set('Cache-Control', 'no-store')
    ctx.body = browserStartPageHtml()
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
  const routers = [accountRouter, uploadRouter, chatRouter, fsRouter, settingsRouter, sessionRouter, persistentGoalsRouter, artifactsRouter, historyRouter, statsRouter, memoryRouter, gatewayRouter, skillsRouter, tasksRouter, automationsRouter, modelsRouter, workspaceRouter, ocrRouter, checkpointsRouter, playbookRouter, rolesRouter, systemRouter, collabRouter, newsRouter, siteRouter, ttsRouter, mcpRouter, routineRouter, personalityRouter, diagnoseRouter, terminalRouter, taskStateRouter, bgTasksRouter, capabilitiesRouter, relayRoutes]
  // 统一任务状态机：回填历史任务（进程重启后仍可查询上次状态，幽灵任务自动收敛为 cancelled）
  try { const n = restoreFromDB(); if (n > 0) console.log(`[task-state] 已回填 ${n} 条历史任务`) } catch { /* 不影响启动 */ }
  for (const r of routers) {
    app.use(r.routes())
    app.use(r.allowedMethods())
  }

  // Health check
  app.use(async (ctx) => {
    if (ctx.path === '/api/health') {
      const el = getEventLoopStats()
      const sse = getSseStats()
      ctx.body = {
        status: 'ok',
        model: config.deepseek.defaultModel,
        uptime: process.uptime(),
        tunnel: getTunnelUrl() || 'offline',
        // 只给最小集：健康检查常被外部监控/隧道探活调用，明细留给 /api/system/diagnostics（仅 localhost）
        eventLoop: { verdict: el.verdict, max_60s_ms: el.max_60s_ms },
        sse: { active: sse.active, dropped: sse.dropped },
      }
      return
    }
    if (ctx.path.startsWith('/api/preview/')) {
      await servePreview(ctx, WORKSPACE_ROOT)
      return
    }
    // SPA fallback
    if (ctx.method === 'GET' && !ctx.path.startsWith('/api/')) {
      const indexPath = join(distPath, 'index.html')
      if (existsSync(indexPath)) {
        ctx.type = 'html'
        ctx.body = await readFile(indexPath, 'utf-8')
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

  // 绑定地址：默认不指定（Node 在 IPv6 可用时绑 `::`，双栈）——这是**原本就正确**的行为。
  // 2026-10-23 曾误判「手机端 adb forward 连不上 = 绑定错了」，实际是 forward 重建时序问题；
  // 这里保留一个可选的 HOST 逃生口（不设则完全维持默认），供确实需要显式绑 IPv4 的场景使用。
  // S2 fix (2026-11-17 audit): default to loopback. Opt into LAN exposure
  // explicitly via HOST=0.0.0.0 (which then REQUIRES the API token on every
  // /api call — see the middleware above).
  const BIND_HOST = process.env.HOST || '127.0.0.1'
  const onListening = () => {
    if (isSignedIn()) startRelayClient()
    const localIP = getLocalIP()
    console.log(`\n🚀 SUPERCRZY BOT running on:`)
    console.log(`   Local:   http://localhost:${PORT}`)
    if (localIP) console.log(`   Network: http://${localIP}:${PORT}`)
    if (getTunnelUrl()) console.log(`   Tunnel:  ${getTunnelUrl()}`)
    console.log(`   Workspace: ${WORKSPACE_ROOT}\n`)

    // 匿名使用统计（2026-10-18）：每进程一次，fire-and-forget，失败静默。
    // 只报 { iid, version, platform, firstRun }，不含任何内容/路径/密钥。
    // 关闭方式：SUPERCRZY_TELEMETRY=0 或 settings 表 telemetry.enabled=false
    import('./services/telemetry').then((m) => m.reportTelemetryOnce()).catch(() => {})

    // 超级协作平台：重启后标记上次未完成任务为"进程中断"（可恢复提示）
    recoverInterruptedTasks()

    // TTS 预热（2026-10-21）：手机端冷启动首条朗读实测要 >8s 握手，预热一次把
    // DNS 缓存与 TLS 会话热起来，避免用户第一次点朗读就吃到冷启动成本。
    // 先选出口（直连 vs 中继），再预热连接 —— 顺序不能反：
    // 预热到错误出口等于白建一条连接，而且它会被当成"可用"干扰后续判断。
    void pickTtsRoute().finally(() => warmUpTts())

    // OCR warmup (2026-10-26): the first macOS Vision call after boot takes ~60s
    // (model load); afterwards 0.35-0.65s. Without this, the first computer_use
    // screenshot after every restart would stall for a minute. Local cache only —
    // a failure is silent because the real call retries.
    void import('./services/ocr-engine')
      .then((m) => m.warmupOcr())
      .then((r) => {
        if (r.ok) console.log(`[OCR] warmup: ${r.engine} ready in ${(r.elapsed / 1000).toFixed(1)}s`)
        else console.log('[OCR] warmup: no engine available (screenshots will degrade to text-only)')
      })
      .catch(() => {})

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
  }

  // HOST 显式给出时按 IPv4/IPv6 指定绑定（手机端 adb forward 只走 IPv4），否则沿用 Node 默认
  //
  // Port fallback: a user opening the desktop app on a machine where 3000 is already taken
  // (another dev server, a second instance, some SDK's default) previously got a raw
  // EADDRINUSE stack and a blank window. Try a short ladder of nearby ports instead, and keep
  // going until one binds. `PORT` is reassigned so the banner, the channel bridge
  // (`agent-bridge` reads process.env.PORT) and the desktop shell all agree on the real port.
  const listenOnce = (port: number) =>
    new Promise<NodeJS.ErrnoException | null>((resolve) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onOk)
        resolve(err)
      }
      const onOk = () => {
        server.removeListener('error', onError)
        resolve(null)
      }
      server.once('error', onError)
      server.once('listening', onOk)
      if (BIND_HOST) server.listen(port, BIND_HOST)
      else server.listen(port)
    })

  const MAX_PORT_TRIES = 20
  for (let attempt = 0; attempt < MAX_PORT_TRIES; attempt++) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: stop at first success
    const err = await listenOnce(PORT + attempt)
    if (!err) {
      if (attempt > 0) {
        console.warn(`[Server] Port ${config.port} was busy; bound to ${PORT + attempt} instead.`)
      }
      PORT = PORT + attempt
      // Channels and the desktop shell resolve the agent URL from PORT. Keep the env in sync
      // with what we actually bound, otherwise they would keep calling the occupied port.
      process.env.PORT = String(PORT)
      onListening()
      break
    }
    if (err.code !== 'EADDRINUSE') {
      console.error(`[Server] Failed to listen on ${PORT + attempt}: ${err.code || err.message}`)
      throw err
    }
    if (attempt === MAX_PORT_TRIES - 1) {
      console.error(
        `[Server] No free port in ${config.port}-${config.port + MAX_PORT_TRIES - 1}. ` +
          'Close whatever is using them, or set PORT to a free one.',
      )
      throw err
    }
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Shutdown] SIGINT received')
    await stopTunnel()
    stopSearxngTunnel()
    stopComputerUse()
    stopAllMcp()
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    console.log('\n[Shutdown] SIGTERM received')
    await stopTunnel()
    stopSearxngTunnel()
    stopComputerUse()
    stopAllMcp()
    process.exit(0)
  })
}

bootstrap().catch((err) => {
  console.error('[Bootstrap] Fatal error:', err)
  process.exit(1)
})
