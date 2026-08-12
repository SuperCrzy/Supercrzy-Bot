#!/bin/bash
# SuperCrzy Relay Server 一键部署脚本
# 在你的 Mac 终端执行: bash deploy-relay.sh

set -e
SERVER="root@107.174.107.199"

echo "=== 1. 连接服务器 ==="
ssh $SERVER "bash -s" << 'ENDSSH'

# 创建目录
mkdir -p /opt/supercrzy/packages/server/src/services
cd /opt/supercrzy/packages/server

# 初始化项目
if [ ! -f package.json ]; then
  npm init -y > /dev/null 2>&1
fi
npm install ws > /dev/null 2>&1
npm install -g tsx > /dev/null 2>&1

echo "=== 2. 写入 relay-server.ts ==="
cat > src/services/relay-server.ts << 'EOF'
import { WebSocketServer, WebSocket } from 'ws'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomUUID } from 'crypto'

interface Agent { id: string; ws: WebSocket; name: string; connectedAt: number }

const agents = new Map<string, Agent>()
const pending = new Map<string, (data: any) => void>()
const PORT = parseInt(process.env.RELAY_PORT || '3100', 10)

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', 'http://localhost')
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (url.pathname === '/' || url.pathname === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    const list = [...agents.values()].map(a =>
      `<div style="background:#16213e;padding:12px;margin:8px 0;border-radius:8px">
        <span style="color:#22c55e">●</span> ${a.name}
        <a href="/${a.id}" style="color:#4F46E5;margin-left:12px">/${a.id}</a>
      </div>`).join('') || '<p style="color:#666">等待 Agent 连接...</p>'
    res.end(`<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SuperCrzy Relay</title><style>*{margin:0;padding:0}body{font-family:system-ui;max-width:640px;margin:40px auto;padding:20px;background:#1a1a2e;color:#e0e0e0}h1{font-size:20px}</style></head><body><h1>SuperCrzy Relay</h1><p style="color:#666;font-size:12px;margin:8px 0 24px">活跃 Agent: ${agents.size} 个</p>${list}</body></html>`)
    return
  }

  const match = url.pathname.match(/^\/([a-z0-9]+)(\/.*)?$/)
  if (!match) { res.writeHead(404).end('Not found'); return }

  const agent = agents.get(match[1])
  if (!agent) { res.writeHead(404).end('Agent offline'); return }

  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    const requestId = randomUUID()
    const timer = setTimeout(() => { pending.delete(requestId); res.writeHead(504).end('Timeout') }, 30000)
    pending.set(requestId, (response: any) => {
      clearTimeout(timer)
      res.writeHead(response.status || 200, { 'Content-Type': response.contentType || 'text/html' })
      res.end(response.body || '')
    })
    agent.ws.send(JSON.stringify({ type: 'proxy', requestId, method: req.method || 'GET', path: match[2] || '/', headers: { host: req.headers.host }, body: Buffer.concat(chunks).toString() }))
  })
})

const wss = new WebSocketServer({ server })

wss.on('connection', (ws) => {
  const id = randomUUID().slice(0, 8)
  const agent: Agent = { id, ws, name: id, connectedAt: Date.now() }
  agents.set(id, agent)
  console.log(`[relay] Agent connected: ${id}`)

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'register') { agent.name = msg.name || id; ws.send(JSON.stringify({ type: 'registered', id, url: `http://localhost:${PORT}/${id}` })) }
      if (msg.type === 'proxy_response') { const cb = pending.get(msg.requestId); if (cb) { pending.delete(msg.requestId); cb(msg) } }
    } catch {}
  })
  ws.on('close', () => { agents.delete(id); console.log(`[relay] Disconnected: ${id}`) })
})

setInterval(() => { for (const a of agents.values()) if (a.ws.readyState === WebSocket.OPEN) a.ws.ping() }, 30000)

server.listen(PORT, () => console.log(`[relay] Listening on :${PORT}`))
EOF

echo "=== 3. 创建 systemd 服务 ==="
cat > /etc/systemd/system/supercrzy-relay.service << 'SVC'
[Unit]
Description=SuperCrzy Relay
After=network.target
[Service]
Type=simple
WorkingDirectory=/opt/supercrzy/packages/server
ExecStart=/usr/bin/npx tsx src/services/relay-server.ts
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable supercrzy-relay
systemctl restart supercrzy-relay

echo "=== 4. Nginx 配置 ==="
cat > /etc/nginx/sites-available/supercrzy-relay << 'NGX'
server {
    listen 80;
    server_name agent.supercrzy.com;
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400s;
        proxy_buffering off;
    }
}
NGX

ln -sf /etc/nginx/sites-available/supercrzy-relay /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

echo "=== 5. 状态 ==="
systemctl status supercrzy-relay --no-pager | head -6
curl -s http://localhost:3100/ | head -5

echo ""
echo "✅ 部署完成！"
echo "   Nginx: agent.supercrzy.com → :3100"
echo "   状态页: http://localhost:3100/"
echo "   PC Agent 连: SUPERCRZY_RELAY=wss://agent.supercrzy.com npm start"
ENDSSH
