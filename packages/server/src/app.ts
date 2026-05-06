import Koa from 'koa'
import cors from '@koa/cors'
import bodyParser from 'koa-bodyparser'
import { createServer } from 'http'
import { config } from './config'
import { initDatabase } from './services/database'
import { createTerminalServer } from './services/terminal'
import { chatRouter } from './routes/chat'
import { settingsRouter } from './routes/settings'
import { sessionRouter } from './routes/session'
import { historyRouter } from './routes/history'
import { statsRouter } from './routes/stats'
import { memoryRouter } from './routes/memory'
import { uploadRouter } from './routes/upload'
import { gatewayRouter, initChannelsTable } from './routes/gateway'
import skillsRouter, { seedBuiltinSkills } from './routes/skills'

async function bootstrap() {
  initDatabase()
  initChannelsTable()
  seedBuiltinSkills()

  const app = new Koa()
  const PORT = config.port

  app.use(cors())
  app.use(bodyParser())

  // API Routes
  const routers = [uploadRouter, chatRouter, settingsRouter, sessionRouter, historyRouter, statsRouter, memoryRouter, gatewayRouter, skillsRouter]
  for (const r of routers) {
    app.use(r.routes())
    app.use(r.allowedMethods())
  }

  // Health check
  app.use(async (ctx) => {
    if (ctx.path === '/api/health') {
      ctx.body = { status: 'ok', model: config.deepseek.defaultModel, uptime: process.uptime() }
      return
    }
    // Root page — show API overview
    if (ctx.path === '/') {
      ctx.type = 'html'
      ctx.body = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>DeepSeek Agent API</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f9fa; color: #1a1a2e; display:flex; justify-content:center; padding:60px 20px; }
.card { background:#fff; border-radius:16px; padding:40px; max-width:640px; width:100%; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
h1 { font-size:24px; font-weight:600; margin-bottom:4px; }
.sub { color:#666; font-size:14px; margin-bottom:32px; }
.status { display:flex; align-items:center; gap:8px; margin-bottom:24px; font-size:14px; }
.dot { width:10px; height:10px; border-radius:50%; background:#22c55e; }
.endpoint { display:flex; align-items:center; justify-content:space-between; padding:12px 0; border-bottom:1px solid #f0f0f0; }
.endpoint:last-child { border-bottom:none; }
.method { font-size:11px; font-weight:600; padding:3px 8px; border-radius:4px; min-width:52px; text-align:center; }
.get { background:#e8f5e9; color:#2e7d32; }
.post { background:#fff3e0; color:#e65100; }
.path { font-family:'SF Mono',Monaco,monospace; font-size:13px; color:#333; }
.desc { font-size:12px; color:#999; }
.footer { margin-top:32px; font-size:12px; color:#bbb; text-align:center; }
</style></head>
<body>
<div class="card">
<h1>DeepSeek Agent</h1>
<p class="sub">AI Agent Platform API Server</p>
<div class="status"><span class="dot"></span>Server Online</div>
<div class="endpoint"><span class="method get">GET</span><span class="path">/api/health</span><span class="desc">健康检查</span></div>
<div class="endpoint"><span class="method post">POST</span><span class="path">/api/chat</span><span class="desc">普通对话</span></div>
<div class="endpoint"><span class="method post">POST</span><span class="path">/api/chat/stream</span><span class="desc">流式对话 (SSE)</span></div>
<div class="endpoint"><span class="method post">POST</span><span class="path">/api/chat/agent</span><span class="desc">Agent 模式 (工具调用)</span></div>
<div class="endpoint"><span class="method get">GET/POST</span><span class="path">/api/settings</span><span class="desc">设置管理</span></div>
<div class="endpoint"><span class="method get">GET/POST</span><span class="path">/api/sessions</span><span class="desc">会话管理</span></div>
<div class="endpoint"><span class="method get">GET/POST</span><span class="path">/api/memory</span><span class="desc">记忆管理</span></div>
<div class="endpoint"><span class="method get">GET</span><span class="path">/api/history</span><span class="desc">对话历史</span></div>
<div class="endpoint"><span class="method get">GET</span><span class="path">/api/stats</span><span class="desc">统计数据</span></div>
<p class="footer">DeepSeek Agent v0.1.0</p>
</div>
</body></html>`
      return
    }
    ctx.status = 404
    ctx.body = { error: 'Not Found' }
  })

  // Create HTTP server and attach both Koa and WebSocket
  const httpServer = createServer(app.callback())
  createTerminalServer(httpServer)

  httpServer.listen(PORT, () => {
    console.log(`🚀 DeepSeek Agent Server running at http://localhost:${PORT}`)
    console.log(`🔧 Terminal WS at ws://localhost:${PORT}/ws/terminal`)
  })
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
