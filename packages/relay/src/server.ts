/**
 * M8 rendezvous relay (Phase 1).
 *
 * Topology (mirrors WorkBuddy's proven design, simplified to one WebSocket channel):
 *
 *   phone (mobile) ⇄ this relay ⇄ desktop BOT server
 *            outbound           outbound
 *
 * Both ends connect OUT to us, so no NAT traversal, no public IP on the desktop,
 * works from any network. The relay only forwards JSON-RPC envelopes between a
 * paired (mobile, desktop) pair — nothing is persisted (zero storage by design).
 *
 * Pairing: the mobile asks for a 6-digit code + its identity token (POST /pair);
 * the desktop claims the code (POST /claim) — claim-time is binding-time, wiring
 * that mobile to this desktop. One desktop per mobile (device exclusivity, like
 * WorkBuddy's "End remote control on that device first").
 *
 * Endpoints:
 *   GET  /health
 *   POST /pair                     → { code, expiresAt }   (mobile)
 *   POST /claim  { code }          → { deviceToken }       (desktop)
 *   WS   /ws/desktop?dt=<token>    (desktop, registers agent)
 *   WS   /ws/mobile?mt=<token>     (mobile)
 *
 * Wire format: JSON-RPC 2.0-ish envelope { jsonrpc:"2.0", id?, method, params }
 * mobile→desktop: session/prompt · session/cancel · session/set_model ·
 *                 session/set_config_option · request/permission-response ·
 *                 remote/pointer · remote/key · remote/frame-request
 * desktop→mobile: session/update (stream chunks, artifacts, status) ·
 *                 request/permission · elicitation/create
 */
import http from 'node:http'
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

const PORT = Number(process.env.RELAY_PORT || 8787)

/** 6-digit pairing code TTL. */
const PAIR_TTL_MS = 5 * 60 * 1000
/** Drop connections that haven't answered a ping in 60s. */
const DEAD_PEER_MS = 60_000

interface DesktopConn {
  ws: WebSocket
  token: string
  deviceName: string
  lastSeen: number
}
interface MobileConn {
  ws: WebSocket
  token: string
  lastSeen: number
}

const desktops = new Map<string, DesktopConn>() // deviceToken → conn
const mobiles = new Map<string, MobileConn>() // mobileToken → conn
/** mobileToken → deviceToken it is paired to (one desktop at a time). */
const bindings = new Map<string, string>()
/** pairing code → { token, expiresAt } */
const pendingCodes = new Map<string, { token: string; expiresAt: number }>()
const claimAttempts = new Map<string, { count: number; resetAt: number }>()

function newToken(): string {
  return randomBytes(24).toString('hex')
}

function newPairCode(): string {
  return String(randomInt(100000, 1000000))
}

/** Forward a JSON envelope from a mobile to its bound desktop (or vice versa). */
function toDesktop(mobileToken: string, envelope: unknown): boolean {
  const dt = bindings.get(mobileToken)
  if (!dt) return false
  const d = desktops.get(dt)
  if (!d || d.ws.readyState !== WebSocket.OPEN) return false
  d.ws.send(JSON.stringify(envelope))
  return true
}
function toMobile(deviceToken: string, envelope: unknown): boolean {
  for (const [mt, dt] of bindings) {
    if (dt !== deviceToken) continue
    const m = mobiles.get(mt)
    if (m && m.ws.readyState === WebSocket.OPEN) m.ws.send(JSON.stringify(envelope))
  }
  return true
}

/** Only these methods cross the relay — an allowlist keeps the surface auditable. */
const MOBILE_METHODS = new Set([
  'session/prompt',
  'session/cancel',
  'session/set_model',
  'session/set_config_option',
  'request/permission-response',
  'remote/pointer',
  'remote/key',
  'remote/frame-request',
])
const DESKTOP_METHODS = new Set([
  'session/update',
  'request/permission',
  'elicitation/create',
])

// ---- M8 P3: workspace channels (register-based, auth-issued HMAC tokens) ----
/** Shared with the IdP (AUTH_RELAY_SECRET). Empty disables workspace mode. */
const RELAY_SECRET = process.env.RELAY_SECRET || ''
/** workspaceId → open connection (one computer per workspace). */
const workspaces = new Map<string, { ws: import('ws').WebSocket; lastSeen: number }>()

function verifyWorkspaceToken(workspaceId: string, ct: string): number | null {
  if (!RELAY_SECRET) return null
  const [version, rawExpiry, nonce, signature, extra] = ct.split('.')
  const expiresAt = Number(rawExpiry)
  if (version !== 'v1' || !/^[0-9]+$/.test(rawExpiry || '') || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 6 * 60_000 || !/^[A-Za-z0-9_-]{22}$/.test(nonce || '') || !signature || extra !== undefined) return null
  const expected = createHmac('sha256', RELAY_SECRET).update(JSON.stringify(['workspace-v1', workspaceId, expiresAt, nonce])).digest('base64url')
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b) ? expiresAt : null
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://relay.local')
  if (url.pathname === '/internal/workspaces/status' && req.method === 'POST') {
    if (!RELAY_SECRET) { res.writeHead(503).end('workspace mode disabled'); return }
    if (req.headers.authorization !== `Bearer ${RELAY_SECRET}`) { res.writeHead(401).end('bad secret'); return }
    let size = 0
    let tooLarge = false
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 32768) { if (!tooLarge) res.writeHead(413).end('body too large'); tooLarge = true; return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { channels?: unknown }
        if (!Array.isArray(body.channels) || body.channels.length > 100 || body.channels.some((channel) => typeof channel !== 'string' || channel.length > 128)) { res.writeHead(400).end('invalid channels'); return }
        const online = body.channels.filter((channel: string) => workspaces.get(channel)?.ws.readyState === WebSocket.OPEN)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ online }))
      } catch { res.writeHead(400).end('invalid json') }
    })
    return
  }
  if (url.pathname === '/internal/publish' && req.method === 'POST') {
    // IdP → relay push (task submission routing). Authenticated by the shared
    // secret; publishes to the workspace channel if that computer is online.
    if (!RELAY_SECRET) { res.writeHead(503).end('workspace mode disabled'); return }
    const auth = req.headers.authorization || ''
    if (auth !== `Bearer ${RELAY_SECRET}`) { res.writeHead(401).end('bad secret'); return }
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 256 * 1024) { if (!tooLarge) res.writeHead(413).end('body too large'); tooLarge = true; return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (tooLarge) return
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { channel?: string; event?: unknown; method?: unknown }
        const method = body.method ?? 'session/prompt'
        if (method !== 'session/prompt' && method !== 'session/cancel') {
          res.writeHead(400).end('invalid method')
          return
        }
        const channel = String(body.channel || '')
        const target = workspaces.get(channel)
        if (!target || target.ws.readyState !== WebSocket.OPEN) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ delivered: false, reason: 'workspace_offline' }))
          return
        }
        target.ws.send(JSON.stringify({ method, params: body.event ?? {} }))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ delivered: true }))
      } catch (e) {
        res.writeHead(400).end(String(e))
      }
    })
    return
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: true,
      workspaces: workspaces.size,
      desktops: desktops.size,
      mobiles: mobiles.size,
      bindings: bindings.size,
      pendingCodes: pendingCodes.size,
    }))
    return
  }
  if (url.pathname === '/pair' && req.method === 'POST') {
    // Rate-limit lightly: at most 5 live codes at once.
    if (pendingCodes.size >= 5) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'too_many_pending_codes' }))
      return
    }
    const token = newToken()
    let code = newPairCode()
    while (pendingCodes.has(code)) code = newPairCode()
    issuedMobileTokens.add(token)
    pendingCodes.set(code, { token, expiresAt: Date.now() + PAIR_TTL_MS })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code, token, expiresAt: Date.now() + PAIR_TTL_MS }))
    return
  }
  if (url.pathname === '/claim' && req.method === 'POST') {
    const peer = req.socket.remoteAddress || 'unknown'
    const now = Date.now()
    let attempts = claimAttempts.get(peer)
    if (!attempts || attempts.resetAt <= now) { attempts = { count: 0, resetAt: now + 60_000 }; claimAttempts.set(peer, attempts) }
    if (++attempts.count > 10) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(Math.ceil((attempts.resetAt - now) / 1000)) })
      res.end(JSON.stringify({ error: 'too_many_attempts' }))
      return
    }
    let body = ''
    let tooLarge = false
    req.on('data', (c: Buffer) => {
      if (tooLarge) return
      if (Buffer.byteLength(body) + c.length > 2048) {
        tooLarge = true
        res.writeHead(413).end('body too large')
        return
      }
      body += c.toString()
    })
    req.on('end', () => {
      if (tooLarge) return
      let code = ''
      let deviceName = 'My Computer'
      try {
        const parsed = JSON.parse(body)
        code = String(parsed.code || '')
        deviceName = String(parsed.deviceName || 'My Computer').slice(0, 64)
      } catch { /* keep defaults */ }
      const entry = pendingCodes.get(code)
      if (!entry || entry.expiresAt < Date.now()) {
        pendingCodes.delete(code)
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'code_invalid_or_expired' }))
        return
      }
      pendingCodes.delete(code)
      const deviceToken = newToken()
      pendingIssuedTokens.add(deviceToken)
      // The code was issued to a mobile, so claiming it pairs that mobile with
      // this desktop (one desktop per mobile — claim-time is binding-time).
      bindings.set(entry.token, deviceToken)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ deviceToken, deviceName }))
    })
    return
  }
  res.writeHead(404)
  res.end()
})

/** Mobile ↔ desktop message pump. */
function handleEnvelope(from: 'mobile' | 'desktop', token: string, raw: WebSocket.RawData) {
  let envelope: { method?: string }
  try {
    envelope = JSON.parse(String(raw))
  } catch {
    return // silently drop malformed frames; the relay is not a validator
  }
  if (from === 'mobile') {
    if (!envelope.method || !MOBILE_METHODS.has(envelope.method)) return
    toDesktop(token, envelope)
  } else {
    if (!envelope.method || !DESKTOP_METHODS.has(envelope.method)) return
    toMobile(token, envelope)
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://relay.local')
  // Workspace channel (register-based): /ws/workspace?channel=<workspaceId>&ct=<HMAC token>
  if (url.pathname === '/ws/workspace') {
    const channel = url.searchParams.get('channel') || ''
    const ct = url.searchParams.get('ct') || ''
    const expiresAt = channel ? verifyWorkspaceToken(channel, ct) : null
    if (!expiresAt) {
      socket.write('HTTP/1.1 401 Invalid workspace token\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => { /* malformed or oversized frames close this peer only */ })
      const expiryTimer = setTimeout(() => ws.close(4004, 'credential expired'), Math.max(0, expiresAt - Date.now()))
      expiryTimer.unref()
      const previous = workspaces.get(channel)
      workspaces.set(channel, { ws, lastSeen: Date.now() })
      if (previous && previous.ws !== ws) previous.ws.close(4003, 'replaced')
      console.log(`[relay] workspace connected: ${channel}`)
      ws.on('pong', () => { const entry = workspaces.get(channel); if (entry?.ws === ws) entry.lastSeen = Date.now() })
      // R4 fix (2026-11-17 audit): only remove the mapping if it still points
      // at THIS socket — a fast reconnect replaces the entry, and the stale
      // connection's close must not delete the new one.
      ws.on('close', () => {
        clearTimeout(expiryTimer)
        const cur = workspaces.get(channel)
        if (cur && cur.ws === ws) {
          workspaces.delete(channel)
          console.log(`[relay] workspace left: ${channel}`)
        }
      })
      // Workspace updates require a separate authenticated delivery protocol.
      // Never echo desktop messages back as new commands.
    })
    return
  }
  const isDesktop = url.pathname === '/ws/desktop'
  const isMobile = url.pathname === '/ws/mobile'
  if (!isDesktop && !isMobile) { socket.destroy(); return }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('error', () => { /* malformed or oversized frames close this peer only */ })
    if (isDesktop) {
      const dt = url.searchParams.get('dt') || ''
      // The token must be one that was issued via /claim.
      if (!pendingIssuedTokens.has(dt)) { ws.close(4001, 'unknown device token'); return }
      const previous = desktops.get(dt)
      desktops.set(dt, { ws, token: dt, deviceName: url.searchParams.get('name') || 'My Computer', lastSeen: Date.now() })
      if (previous && previous.ws !== ws) previous.ws.close(4003, 'replaced')
      ws.on('message', (raw) => { if (desktops.get(dt)?.ws === ws) handleEnvelope('desktop', dt, raw) })
      ws.on('pong', () => { const d = desktops.get(dt); if (d?.ws === ws) d.lastSeen = Date.now() })
      ws.on('close', () => {
        if (desktops.get(dt)?.ws === ws) desktops.delete(dt)
      })
    } else {
      const mt = url.searchParams.get('mt') || ''
      if (!issuedMobileTokens.has(mt)) { ws.close(4002, 'unknown mobile token'); return }
      const previous = mobiles.get(mt)
      mobiles.set(mt, { ws, token: mt, lastSeen: Date.now() })
      if (previous && previous.ws !== ws) previous.ws.close(4003, 'replaced')
      ws.on('message', (raw) => { if (mobiles.get(mt)?.ws === ws) handleEnvelope('mobile', mt, raw) })
      ws.on('pong', () => { const m = mobiles.get(mt); if (m?.ws === ws) m.lastSeen = Date.now() })
      ws.on('close', () => { if (mobiles.get(mt)?.ws === ws) mobiles.delete(mt) })
    }
  })
})

/** Tokens issued by /claim (desktop) and a lightweight mobile token source. */
const pendingIssuedTokens = new Set<string>()
const issuedMobileTokens = new Set<string>()

// Reap dead peers and expired codes every 15s.
setInterval(() => {
  const now = Date.now()
  for (const [code, entry] of pendingCodes) if (entry.expiresAt < now) { pendingCodes.delete(code); issuedMobileTokens.delete(entry.token) }
  for (const [peer, attempts] of claimAttempts) if (attempts.resetAt <= now) claimAttempts.delete(peer)
  for (const entry of [...desktops.values(), ...mobiles.values(), ...workspaces.values()]) {
    if (entry.ws.readyState !== WebSocket.OPEN) continue
    const idle = now - entry.lastSeen
    if (idle > DEAD_PEER_MS * 2) entry.ws.terminate()
    else if (idle > DEAD_PEER_MS) entry.ws.ping()
  }
}, 15_000).unref()

server.listen(PORT, process.env.RELAY_HOST || undefined, () => {
  const address = server.address()
  const actualPort = typeof address === 'object' && address ? address.port : PORT
  console.log(`[relay] listening on :${actualPort} — desktops:${desktops.size} mobiles:${mobiles.size}`)
})
