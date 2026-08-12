/**
 * Agent WebSocket Server (stub)
 * WebSocket-based agent communication server.
 */
import type { Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'

export function createAgentWSServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws/agent' })

  wss.on('connection', (ws: WebSocket) => {
    console.log('[agent-ws] Client connected')

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        ws.send(JSON.stringify({ type: 'ack', id: msg.id }))
      } catch {
        ws.send(JSON.stringify({ error: 'invalid message' }))
      }
    })

    ws.on('close', () => {
      console.log('[agent-ws] Client disconnected')
    })
  })

  console.log('[agent-ws] WebSocket server ready at /ws/agent')
  return wss
}
