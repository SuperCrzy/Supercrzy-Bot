/**
 * 穿透服务 — 三梯级方案
 * Tier 1: 自建 Relay Server (SUPERCRZY_RELAY 环境变量)
 * Tier 2: localtunnel (零配置，自动)
 */
import localtunnel from 'localtunnel'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import WebSocket from 'ws'

let tunnelUrl = ''
let relayWs: WebSocket | null = null
let agentId = ''
let activeTunnel: any = null // 追踪活跃的 localtunnel 实例

const WORKSPACE = process.cwd()
const RELAY_URL = process.env.SUPERCRZY_RELAY || ''

export async function startTunnel(port: number): Promise<string> {
  // Tier 1: 自建中继
  if (RELAY_URL) {
    return startRelay(RELAY_URL, port)
  }

  // Tier 2: localtunnel
  return startLocaltunnel(port)
}

async function startRelay(relayUrl: string, localPort: number): Promise<string> {
  return new Promise((resolve) => {
    const url = relayUrl.endsWith('/') ? relayUrl + 'agent' : relayUrl + '/agent'
    let retries = 0

    function connect() {
      try {
        relayWs = new WebSocket(url)

        relayWs.on('open', () => {
          retries = 0
          relayWs!.send(JSON.stringify({
            type: 'register',
            name: `agent-${process.env.HOSTNAME || process.env.USER || 'pc'}`,
            port: localPort,
          }))
        })

        relayWs.on('message', (raw) => {
          try {
            const msg = JSON.parse(raw.toString())
            if (msg.type === 'registered') {
              agentId = msg.id
              // 从 relay URL 正确构造隧道地址
              const parsed = new URL(relayUrl)
              tunnelUrl = msg.url || `${parsed.protocol.replace('ws', 'http')}//${parsed.host}/${msg.id}`
              console.log(`[relay] Connected as ${agentId}, URL: ${tunnelUrl}`)
              resolve(tunnelUrl)
            }
            if (msg.type === 'proxy') {
              handleRelayProxy(msg, localPort)
            }
          } catch {}
        })

        relayWs.on('close', () => {
          retries++
          if (retries > 10) {
            console.warn('[relay] Max retries reached, falling back to localtunnel')
            startLocaltunnel(localPort).then(resolve)
            return
          }
          const delay = Math.min(1000 * Math.pow(2, retries), 60000)
          console.log(`[relay] Reconnecting in ${delay / 1000}s (attempt ${retries}/10)...`)
          tunnelUrl = ''
          setTimeout(connect, delay)
        })

        relayWs.on('error', () => {
          relayWs?.close()
        })
      } catch {
        retries++
        if (retries > 10) {
          startLocaltunnel(localPort).then(resolve)
          return
        }
        setTimeout(connect, 5000 * retries)
      }
    }

    connect()
  })
}

async function startLocaltunnel(port: number): Promise<string> {
  // 关闭旧 tunnel 并清理
  if (activeTunnel) {
    try { activeTunnel.close() } catch {}
    activeTunnel = null
  }

  // 备用 localtunnel hosts（主服务器可能被墙/不可用）
  const hosts = [
    'https://localtunnel.me',
    'https://server.loca.lt',
    'https://tunnel.boringtun.club',
  ]

  // 带超时的 tunnel 创建
  for (let attempt = 0; attempt < hosts.length; attempt++) {
    const host = hosts[attempt]
    const subdomain = 'supercrzy-' + Math.random().toString(36).slice(2, 8)

    try {
      const tunnel = await withTimeout(
        localtunnel({ port, host, subdomain }),
        8000
      )
      activeTunnel = tunnel
      tunnelUrl = tunnel.url
      console.log(`[tunnel] Connected via ${host}: ${tunnelUrl}`)

      tunnel.on('close', () => {
        console.log('[tunnel] Connection closed, reconnecting...')
        tunnelUrl = ''
        activeTunnel = null
        setTimeout(async () => {
          try {
            const url = await startLocaltunnel(port)
            if (url) tunnelUrl = url
          } catch {}
        }, 3000)
      })
      // P0: 确保 error 事件不会导致进程崩溃
      tunnel.on('error', (err: any) => {
        console.warn('[tunnel] Error (caught):', err?.message || err)
        tunnelUrl = ''
        try { tunnel.close() } catch {}
        activeTunnel = null
      })
      // P0: 监听未处理的错误事件
      tunnel.on('close', () => {})
      tunnel.on('end', () => {})

      return tunnel.url
    } catch (e: any) {
      console.warn(`[tunnel] Attempt ${attempt + 1}/${hosts.length} via ${host} failed:`, e.message)
      activeTunnel = null
      if (attempt < hosts.length - 1) {
        // 指数退避重试
        await sleep(Math.min(1000 * Math.pow(2, attempt), 8000))
      }
    }
  }

  console.warn('[tunnel] All attempts failed. Preview links will be unavailable.')
  return ''
}

export function getTunnelUrl(): string {
  return tunnelUrl
}

export function createPreviewLink(filePath: string): string {
  // 支持绝对路径（agent 可能在任意目录写文件）
  const absPath = filePath.startsWith('/') ? filePath : join(WORKSPACE, filePath)
  const shortName = filePath.split('/').pop() || filePath
  if (!existsSync(absPath)) return `[文件生成中] ${shortName}`
  if (!tunnelUrl) return `[隧道未连接] 文件已保存，请稍后刷新或重启服务后访问`

  // 编码绝对路径
  return `${tunnelUrl}/api/preview/${encodeURIComponent(filePath)}`
}

export function renderPreviewPage(filePath: string, content: string): string {
  if (filePath.endsWith('.html')) return content
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${filePath}</title>
<style>*{margin:0;padding:0}body{font-family:system-ui;background:#1a1a2e;color:#e0e0e0;padding:20px}pre{white-space:pre-wrap;font-size:13px;line-height:1.6;background:#16213e;padding:16px;border-radius:8px}.h{font-size:11px;color:#666;margin-bottom:8px}</style></head>
<body><div class="h">📄 ${filePath}</div><pre>${escapeHtml(content.slice(0, 100000))}</pre></body></html>`
}

function escapeHtml(s: string): string { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

/** Promise 超时包装 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ])
}

/** 延迟工具 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function stopTunnel(): void {
  relayWs?.close()
  if (activeTunnel) {
    try { activeTunnel.close() } catch {}
    activeTunnel = null
  }
  tunnelUrl = ''
}

/** 处理 Relay 转发的 HTTP 请求 */
async function handleRelayProxy(msg: any, localPort: number) {
  try {
    const url = `http://localhost:${localPort}${msg.path}`
    const res = await fetch(url, {
      method: msg.method || 'GET',
      headers: msg.headers || {},
      body: msg.body || undefined,
    })
    const body = await res.text()
    relayWs?.send(JSON.stringify({
      type: 'proxy_response',
      requestId: msg.requestId,
      status: res.status,
      contentType: res.headers.get('content-type') || 'text/html',
      body,
    }))
  } catch (e: any) {
    relayWs?.send(JSON.stringify({
      type: 'proxy_response',
      requestId: msg.requestId,
      status: 502,
      body: `Error: ${e.message}`,
    }))
  }
}
