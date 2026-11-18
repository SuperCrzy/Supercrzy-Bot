/**
 * M8 Phase 2: outbound relay client — connects the desktop BOT server to the
 * rendezvous relay so the phone can reach it from ANY network (both ends dial out).
 *
 * Wiring philosophy: DO NOT touch the agent core. When the phone sends
 * `session/prompt`, this client posts to the LOCAL chat endpoint (127.0.0.1:3000)
 * and republishes the SSE stream as `session/update` envelopes over the relay WS.
 * Approval, checkpoints, permission logic all stay inside the existing pipeline;
 * the relay only carries "requests" and "events" (see M8_RELAY_PLAN_2026-11-14.md).
 *
 * V1 scope: prompt/cancel + SSE→update bridge + approval-request forward.
 * M7 (remote/pointer → sendInputEvent) hooks in here later, same envelope pump.
 */
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { getDB } from './database'
import { readSession, isSignedIn } from './account-store'
import { ensureAccessToken } from './account-auth'
import { cancelRemoteTask, runRemoteTask } from './remote-task-bridge'
import { requestAllRemoteRunsStop } from './remote-run-control'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30_000

interface RelayConfig {
  relayUrl: string // e.g. wss://relay.supercrzy.com
  deviceToken: string // issued by /claim at pairing time
  deviceName: string
}

export interface RelayStatus {
  connected: boolean
  relayUrl: string
  deviceName: string
}

let ws: WebSocket | null = null
let currentCfg: RelayConfig | null = null
let backoff = RECONNECT_BASE_MS
let stopped = true
let generation = 0
let reconnectTimer: NodeJS.Timeout | null = null

/** Settings live in the `settings(key,value)` table (same store the web client writes). */
function setSetting(key: string, value: string): void {
  try {
    const db = getDB()
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value)
  } catch { /* settings table may not exist in tests */ }
}

function getSetting(key: string): string | null {
  try {
    const db = getDB()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value || null
  } catch {
    return null
  }
}

export function loadRelayConfig(): RelayConfig | null {
  const relayUrl = getSetting('relayUrl')
  const deviceToken = getSetting('relayDeviceToken')
  if (!relayUrl || !deviceToken) return null
  return { relayUrl, deviceToken, deviceName: getSetting('relayDeviceName') || 'My Computer' }
}

export async function getRelayStatus(): Promise<RelayStatus> {
  const cfg = currentCfg || loadRelayConfig()
  return {
    connected: !!(ws && ws.readyState === WebSocket.OPEN),
    relayUrl: cfg?.relayUrl || '',
    deviceName: cfg?.deviceName || '',
  }
}

/** Strip the port if the relay URL already carries one is NOT done — caller passes the full ws/wss origin. */
export function startRelayClient(): void {
  if (!stopped) return
  stopped = false
  generation++
  dial()
}

export function stopRelayClient(): void {
  requestAllRemoteRunsStop()
  stopped = true
  generation++
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  ws?.close()
  ws = null
}

function dial(): void {
  if (stopped || ws) return
  const currentGeneration = generation
  // Workspace mode first (account registered); pairing mode is the fallback
  // for machines that never signed in.
  const sessionCfg = loadWorkspaceConnection()
  if (sessionCfg) {
    dialWorkspace(sessionCfg)
    return
  }
  // R1 fix (2026-11-17 audit): nothing ever CALLED registerWorkspace — a signed
  // in machine without cached credentials would silently fall through to
  // pairing mode (or idle). Register now, then dial the workspace channel.
  if (isSignedIn()) {
    void registerWorkspace(currentGeneration)
      .then((conn) => {
        if (currentGeneration !== generation || stopped) return
        if (conn && !ws) dialWorkspace(conn)
        else if (!conn) scheduleReconnect(15_000)
      })
      .catch(() => { if (currentGeneration === generation) scheduleReconnect(15_000) })
    return
  }
  const cfg = loadRelayConfig()
  if (!cfg) {
    // Not paired and not signed in — retry quietly; either path writes the
    // settings and the next tick picks it up.
    scheduleReconnect(15_000)
    return
  }
  currentCfg = cfg
  const url = `${cfg.relayUrl.replace(/\/+$/, '')}/ws/desktop?dt=${cfg.deviceToken}&name=${encodeURIComponent(cfg.deviceName)}`
  console.log(`[relay-client] dialing (pairing mode) ${cfg.relayUrl}`)
  openWs(url, () => {
    backoff = RECONNECT_BASE_MS
    console.log('[relay-client] connected to relay (pairing)')
  }, (raw) => {
    handleFromRelay(String(raw)).catch((e) => console.error('[relay-client] handler error:', e))
  })
}

/** Opaque per-account installation ID; hostnames are neither unique nor secret. */
function stableHostId(accountId: string): string {
  const key = `relayHostId:${accountId}`
  const existing = getSetting(key)
  if (existing) return existing
  const id = `host-${randomUUID()}`
  setSetting(key, id)
  return id
}

interface WorkspaceConnection {
  channel: string
  connectionToken: string
  relayUrl: string
  expiresAt: number
}

/** Registered workspace credentials, cached in settings by the registrar. */
function loadWorkspaceConnection(): WorkspaceConnection | null {
  const session = isSignedIn() ? readSession() : null
  if (!session || getSetting('workspaceAccountId') !== session.accountId) return null
  const authOrigin = (process.env.SUPERCRZY_AUTH_ORIGIN || 'https://auth.supercrzy.com').replace(/\/+$/, '')
  if (getSetting('workspaceAuthOrigin') !== authOrigin) return null
  const channel = getSetting('workspaceChannel')
  const connectionToken = getSetting('workspaceConnectionToken')
  const relayUrl = getSetting('workspaceRelayUrl')
  const expiresAt = Number(getSetting('workspaceTokenExpiresAt'))
  if (!channel || !connectionToken || !relayUrl || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() + 30_000) return null
  return { channel, connectionToken, relayUrl, expiresAt }
}

/** Register this machine against the signed-in account and cache the credentials. */
async function registerWorkspace(expectedGeneration: number): Promise<WorkspaceConnection | null> {
  if (!isSignedIn()) return null
  const session = readSession()
  if (!session?.accountId) return null
  const token = await ensureAccessToken()
  if (!token || stopped || generation !== expectedGeneration || readSession()?.accountId !== session.accountId) return null
  const authOrigin = (process.env.SUPERCRZY_AUTH_ORIGIN || 'https://auth.supercrzy.com').replace(/\/+$/, '')
  const hostId = stableHostId(session.accountId)
  try {
    const res = await fetch(`${authOrigin}/workspaces/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ workspaceId: hostId, hostId, name: `SUPERCRZY BOT — ${hostname()}` }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      console.error(`[relay-client] workspace register ${res.status}`)
      return null
    }
    const body = (await res.json()) as { channel: string; connectionToken: string; expiresAt: number }
    if (stopped || generation !== expectedGeneration || !isSignedIn() || readSession()?.accountId !== session.accountId) return null
    if (!body.channel || !body.connectionToken || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= Date.now() + 30_000) return null
    // The relay is a separate deployment from the IdP — its URL comes from env.
    const relayUrl = process.env.SUPERCRZY_RELAY_URL || 'wss://agent.supercrzy.com'
    const conn: WorkspaceConnection = { channel: body.channel, connectionToken: body.connectionToken, relayUrl, expiresAt: body.expiresAt }
    setSetting('workspaceChannel', conn.channel)
    setSetting('workspaceConnectionToken', conn.connectionToken)
    setSetting('workspaceTokenExpiresAt', String(conn.expiresAt))
    setSetting('workspaceRelayUrl', relayUrl)
    setSetting('workspaceAccountId', session.accountId)
    setSetting('workspaceAuthOrigin', authOrigin)
    return conn
  } catch (e) {
    console.error('[relay-client] workspace register failed:', e)
    return null
  }
}

function dialWorkspace(conn: WorkspaceConnection): void {
  const base = conn.relayUrl.replace(/\/+$/, '')
  const url = `${base}/ws/workspace?channel=${encodeURIComponent(conn.channel)}&ct=${encodeURIComponent(conn.connectionToken)}`
  console.log(`[relay-client] dialing (workspace) ${base} channel=${conn.channel}`)
  openWs(url, () => {
    backoff = RECONNECT_BASE_MS
    console.log('[relay-client] connected to relay (workspace mode) — ready for tasks')
  }, (raw) => {
    handleFromRelay(String(raw)).catch((e) => console.error('[relay-client] task error:', e))
  }, conn.expiresAt)
}

/** Shared WS opener: reconnect + message pump, common to both modes. */
function openWs(url: string, onOpen: () => void, onMessage: (raw: string) => void, expiresAt?: number): void {
  let socket: WebSocket
  try {
    socket = new WebSocket(url)
    ws = socket
  } catch (e) {
    scheduleReconnect()
    return
  }
  const expiryTimer = expiresAt ? setTimeout(() => { if (ws === socket) socket.close() }, Math.max(0, expiresAt - Date.now() - 30_000)) : null
  expiryTimer?.unref()
  socket.on('open', () => { if (ws === socket && !stopped) onOpen() })
  socket.on('message', (raw) => { if (ws === socket && !stopped) onMessage(String(raw)) })
  socket.on('close', () => {
    if (expiryTimer) clearTimeout(expiryTimer)
    if (ws !== socket) return
    console.log('[relay-client] disconnected')
    ws = null
    scheduleReconnect()
  })
  socket.on('error', () => { /* close follows */ })
}

function scheduleReconnect(delay = backoff): void {
  if (stopped || reconnectTimer) return
  reconnectTimer = setTimeout(() => { reconnectTimer = null; dial() }, delay)
  reconnectTimer.unref()
  if (delay === backoff) backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
}

function sendToRelay(envelope: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(envelope))
}

/**
 * Phone → desktop methods. `session/prompt` bridges to the local chat pipeline via
 * HTTP self-call, republishing the SSE stream as session/update envelopes.
 */
async function handleFromRelay(raw: string): Promise<void> {
  let env: { method: string; params?: Record<string, unknown>; id?: unknown }
  try { env = JSON.parse(raw) } catch { return }
  switch (env.method) {
    case 'session/prompt':
      await bridgePromptToChat(env.params || {})
      break
    case 'session/cancel':
      await cancelRemoteRequest(env.params || {})
      break
    default:
      break // allowlist lives on the relay; anything here is already vetted
  }
}

async function cancelRemoteRequest(params: Record<string, unknown>): Promise<void> {
  const session = isSignedIn() ? readSession() : null
  const requestGeneration = generation
  const taskId = typeof params.taskId === 'string' ? params.taskId : ''
  if (!session || !taskId || taskId.length > 200 || (params.submittedBy && params.submittedBy !== session.accountId)) return
  try {
    const { requestStop } = await import('./agent')
    if (stopped || generation !== requestGeneration || !isSignedIn() || readSession()?.accountId !== session.accountId) return
    const accepted = cancelRemoteTask(getDB(), session.accountId, taskId, requestStop)
    if (!stopped && generation === requestGeneration && isSignedIn() && readSession()?.accountId === session.accountId) {
      sendToRelay({ method: 'session/update', params: { type: accepted ? 'cancel_requested' : 'cancel_unavailable', taskId } })
    }
  } catch (error) {
    console.warn('[relay-client] cancellation failed:', error instanceof Error ? error.message : String(error))
  }
}

/**
 * POST the prompt to the local agent endpoint and republish its SSE stream as
 * session/update envelopes. Using the HTTP self-call instead of runAgentLoop()
 * directly keeps a single entry point: approval popups, checkpoints, tool progress
 * — all existing behavior — keep working unchanged, whether the caller is the web
 * client or the phone.
 */
async function bridgePromptToChat(params: Record<string, unknown>): Promise<void> {
  // agent-gateway submits `prompt`; the phone pairing path submits `text`.
  const text = String(params.text || params.prompt || '')
  const sessionId = params.sessionId ? String(params.sessionId) : undefined
  const taskId = params.taskId ? String(params.taskId) : randomUUID()
  const session = isSignedIn() ? readSession() : null
  const requestGeneration = generation
  if (!session || (params.submittedBy && params.submittedBy !== session.accountId)) return
  if (!text.trim() || text.length > 32_000 || taskId.length > 200 || (sessionId && sessionId.length > 200)) return
  try {
    const base = process.env.SUPERCRZY_LOCAL_API || `http://127.0.0.1:${process.env.PORT || '3000'}`
    const result = await runRemoteTask({
      db: getDB(), accountId: session.accountId, taskId, prompt: text, sessionId, baseUrl: base,
      onEvent: (event) => {
        // Do not deliver a previous account's results to a later login.
        if (!stopped && generation === requestGeneration && isSignedIn() && readSession()?.accountId === session.accountId) {
          sendToRelay({ method: 'session/update', params: event })
        }
      },
    })
    if (result.duplicate && !stopped && generation === requestGeneration && isSignedIn() && readSession()?.accountId === session.accountId) {
      sendToRelay({ method: 'session/update', params: { type: 'duplicate', taskId, ...result } })
    }
  } catch (e) {
    if (!stopped && generation === requestGeneration && isSignedIn() && readSession()?.accountId === session.accountId) {
      sendToRelay({ method: 'session/update', params: { type: 'error', taskId, message: String(e) } })
    }
  }
}
