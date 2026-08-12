/**
 * SuperCrzy Relay Server — 完整 HTTP 代理
 * 
 * 数据流:
 *   Browser → relay (HTTP request)
 *     → relay forwards to Agent (WebSocket)
 *       → Agent handles locally  
 *         → Agent returns to relay (WebSocket)
 *           → relay responds to Browser (HTTP response)
 */
import { WebSocketServer, WebSocket } from 'ws'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomUUID } from 'crypto'

interface AgentConnection {
  id: string; ws: WebSocket; name: string; connectedAt: number
}

const agents = new Map<string, AgentConnection>()
const pending = new Map<string, (data: any) => void>()

const PORT = parseInt(process.env.RELAY_PORT || '3100', 10)

// ---- HTTP Server ----
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', `http://localhost`)
  const path = url.pathname

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // Agent 列表
  if (path === '/api/agents' || path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(renderPage())
    return
  }

  // 转发 HTTP 请求到 Agent: /{agent-id}/path
  const match = path.match(/^\/([a-z0-9]+)(\/.*)?$/)
  if (!match) { res.writeHead(404).end('Not found'); return }

  const agentId = match[1]
  const agentPath = match[2] || '/'
  const agent = agents.get(agentId)
  if (!agent) { res.writeHead(404).end('Agent offline'); return }

  // 读取 body
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString()

    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(requestId)
      res.writeHead(504).end('Agent timeout')
    }, 30000)

    pending.set(requestId, (response) => {
      clearTimeout(timer)
      res.writeHead(response.status || 200, { 'Content-Type': response.contentType || 'text/html' })
      res.end(response.body || '')
    })

    agent.ws.send(JSON.stringify({
      type: 'proxy',
      requestId,
      method: req.method || 'GET',
      path: agentPath,
      headers: { host: req.headers.host },
      body,
    }))
  })
})

// ---- WebSocket ----
const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  const id = randomUUID().slice(0, 8)
  const agent: AgentConnection = { id, ws, name: id, connectedAt: Date.now() }
  agents.set(id, agent)
  console.log(`[relay] Agent connected: ${id} (total: ${agents.size})`)

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())

      // Agent 注册
      if (msg.type === 'register') {
        agent.name = msg.name || id
        ws.send(JSON.stringify({ type: 'registered', id, url: `${serverUrl()}/${id}` }))
        return
      }

      // Agent 返回代理响应
      if (msg.type === 'proxy_response') {
        const cb = pending.get(msg.requestId)
        if (cb) {
          pending.delete(msg.requestId)
          cb(msg)
        }
        return
      }
    } catch {}
  })

  ws.on('close', () => {
    agents.delete(id)
    // 清理该 Agent 的待处理请求
    for (const [rid, cb] of pending) {
      cb({ status: 502, body: 'Agent disconnected' })
      pending.delete(rid)
    }
    console.log(`[relay] Agent disconnected: ${id}`)
  })

  ws.on('pong', () => {}) // keepalive
})

// 心跳保活
setInterval(() => {
  for (const agent of agents.values()) {
    if (agent.ws.readyState === WebSocket.OPEN) agent.ws.ping()
  }
}, 30000)

server.listen(PORT, () => console.log(`[relay] Listening on :${PORT}`))

function serverUrl(): string {
  return process.env.RELAY_PUBLIC_URL || `http://localhost:${PORT}`
}

function renderPage(): string {
  const agentsHtml = agents.size > 0
    ? [...agents.values()].map(a =>
        `<div class="agent">
          <span class="online">●</span>
          <strong>${a.name}</strong>
          <a href="/${a.id}" style="color:#4F46E5;margin-left:12px">/${a.id}</a>
          <span style="color:#666;font-size:11px;margin-left:8px">
            ${Math.floor((Date.now() - a.connectedAt) / 60000)}分钟前连接
          </span>
        </div>`).join('')
    : '<p style="color:#666">等待 PC Agent 连接...</p>'

  return `<!DOCTYPE html><html lang="zh">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SuperCrzy Relay</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;max-width:640px;margin:40px auto;padding:20px;background:#1a1a2e;color:#e0e0e0}
h1{font-size:20px;margin-bottom:8px}
.sub{font-size:12px;color:#666;margin-bottom:24px}
.agent{background:#16213e;border-radius:8px;padding:12px;margin:8px 0;display:flex;align-items:center}
.online{color:#22c55e;margin-right:8px}
.setup{background:#16213e;border-radius:8px;padding:16px;margin-top:24px}
.setup code{color:#4F46E5;font-size:13px}
</style></head>
<body><h1>SuperCrzy Relay</h1>
<p class="sub">自建中继服务 — 手机远程访问 PC Agent</p>
${agentsHtml}
<div class="setup">
  <p style="font-size:13px;margin-bottom:8px">PC Agent 连接命令:</p>
  <code>SUPERCRZY_RELAY=wss://${serverUrl().replace('http', 'ws')}/ npm start</code>
</div></body></html>`
}
