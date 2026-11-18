/**
 * M8 Phase 2: desktop-side pairing + status routes.
 * The desktop asks the relay for a pairing code (shown in Settings → 远程连接),
 * the phone enters it and claims the device. Also: relay on/off + status.
 */
import Router from 'koa-router'
import { getDB } from '../services/database'
import { getRelayStatus, startRelayClient, stopRelayClient } from '../services/relay-client'

const router = new Router({ prefix: '/api/relay' })

/** Read a relay setting from the shared settings table. */
function getSetting(key: string): string | null {
  try {
    const db = getDB()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value || null
  } catch {
    return null
  }
}
function setSetting(key: string, value: string): void {
  const db = getDB()
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(key, value)
}

/** Status for the settings UI. */
router.get('/status', async (ctx) => {
  ctx.body = await getRelayStatus()
})

/**
 * Request a pairing code from the relay and remember this desktop's identity.
 * The UI shows the code; the phone claims it via relay /claim.
 * Body: { relayUrl, deviceName }
 */
router.post('/pair', async (ctx) => {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const relayUrl = String(body.relayUrl || '').replace(/\/+$/, '')
  const deviceName = String(body.deviceName || 'My Computer').slice(0, 64)
  if (!relayUrl) {
    ctx.status = 400
    ctx.body = { error: 'relayUrl required' }
    return
  }
  try {
    const res = await fetch(`${relayUrl}/pair`, { method: 'POST' })
    const data = (await res.json()) as { code: string; token: string; expiresAt: number }
    // Persist: relay URL, the code→token mapping is the DESKTOP token path — the
    // phone claims the code and gets ITS device token; the code's own token is the
    // mobile identity. The desktop stores relayUrl + deviceName here; after the
    // phone claims, the desktop learns its deviceToken via /api/relay/activate.
    setSetting('relayUrl', relayUrl)
    setSetting('relayDeviceName', deviceName)
    setSetting('relayPendingCode', data.code)
    ctx.body = { code: data.code, expiresAt: data.expiresAt }
  } catch (e) {
    ctx.status = 502
    ctx.body = { error: `relay unreachable: ${String(e)}` }
  }
})

/**
 * After the phone claims the code, the desktop stores ITS token (delivered by the
 * phone over the pairing channel or entered manually in V1) and starts dialing.
 * Body: { deviceToken }
 */
router.post('/activate', async (ctx) => {
  const deviceToken = String((ctx.request.body as Record<string, unknown> | undefined)?.deviceToken || '')
  if (!deviceToken) {
    ctx.status = 400
    ctx.body = { error: 'deviceToken required' }
    return
  }
  setSetting('relayDeviceToken', deviceToken)
  startRelayClient()
  ctx.body = await getRelayStatus()
})

router.post('/stop', async (ctx) => {
  stopRelayClient()
  ctx.body = { stopped: true }
})

export default router
