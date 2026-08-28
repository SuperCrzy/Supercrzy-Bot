/**
 * 幽灵工作台 WebSocket 通道（/ws/ghost）
 * 订阅 ghostBus 事件并推送给前端看板；新连接时推送当前任务快照。
 *
 * 注意：必须用 noServer 模式 + 手动处理 upgrade——因为 terminal WSS 已用
 * `{ server, path }` 注册（先注册者抢先处理 upgrade），共享 server 时
 * 后注册的 { server, path } 实例会被前面实例拦截（400）。
 */
import { WebSocketServer, WebSocket } from 'ws'
import { Server } from 'http'
import { ghostBus, listGhostTasks } from './ghost-engine'

const clients = new Set<WebSocket>()
const wss = new WebSocketServer({ noServer: true })

export function createGhostServer(server: Server) {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname !== '/ws/ghost') return  // 其他 path 留给其他 ws 服务
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    clients.add(ws)
    // 新连接：推送当前全部任务快照（看板初始化）
    ws.send(JSON.stringify({ type: 'snapshot', tasks: listGhostTasks() }))
    ws.on('close', () => clients.delete(ws))
  })

  // 幽灵事件 → 广播所有已连接客户端
  // 注意区分：'event' 是引擎内部管道（fake ctx 转发），不广播；广播的是 'update'/'task'/'done'
  const forward = (payload: any) => {
    const raw = JSON.stringify({ type: 'ghost', ...payload })
    for (const c of clients) {
      if (c.readyState === WebSocket.OPEN) c.send(raw)
    }
  }
  ghostBus.on('update', forward)
  ghostBus.on('task', (p: any) => forward({ event: 'task', ...p }))
  ghostBus.on('done', (p: any) => forward({ event: 'done', ...p }))

  return wss
}
