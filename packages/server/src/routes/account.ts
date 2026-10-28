/**
 * Desktop sign-in: authorization-code + PKCE handed off through the system
 * browser, with the code coming back on a loopback redirect (RFC 8252).
 *
 * Why the system browser and not an embedded view: the reader has to be able to
 * check the address bar before typing a login code. Why loopback and not a
 * custom scheme: any app on the machine can claim `supercrzy://`, but only this
 * process can answer on its own port. Why PKCE on top: the code travels through
 * a browser redirect, so it is bound to a verifier that never leaves this
 * process.
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { clearSession, readSession, writeSession, isSignedIn } from '../services/account-store'

export const accountRouter = new Router()

const PENDING_TTL_MS = 10 * 60 * 1000

interface PendingLogin {
  verifier: string
  createdAt: number
  callbackUrl: string
}

/** In-memory only: a half-finished login must not survive a restart. */
const pending = new Map<string, PendingLogin>()

function authOrigin(): string {
  return (process.env.SUPERCRZY_AUTH_ORIGIN || 'https://auth.supercrzy.com').replace(/\/$/, '')
}

function prunePending(now = Date.now()): void {
  for (const [state, entry] of pending) {
    if (now - entry.createdAt > PENDING_TTL_MS) pending.delete(state)
  }
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The caller still gets the URL back, so the client can show a copyable link.
  }
}

function htmlPage(ctx: Context, status: number, title: string, detail: string): void {
  ctx.status = status
  ctx.type = 'html'
  ctx.set('Cache-Control', 'no-store')
  ctx.body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — SUPERCRZY BOT</title>
<style>
  :root{color-scheme:light dark}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
       background:#0f1419;color:#e8edf3}
  .card{max-width:420px;padding:40px 36px;border-radius:20px;background:#171e26;
        border:1px solid rgba(255,255,255,.08);text-align:center}
  h1{margin:0 0 10px;font-size:19px;letter-spacing:-.01em}
  p{margin:0;color:#9aa7b4;font-size:14px}
  .mark{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;
        border-radius:50%;margin-bottom:18px;background:rgba(0,255,136,.12);color:#00ff88;font-size:20px}
  .bad{background:rgba(255,90,90,.12);color:#ff5a5a}
</style></head><body><div class="card">
<div class="mark${status >= 400 ? ' bad' : ''}">${status >= 400 ? '!' : '&#10003;'}</div>
<h1>${title}</h1><p>${detail}</p>
</div></body></html>`
}

/** Start a login: mint verifier + state, open the browser, hand the URL back. */
accountRouter.post('/api/account/login/start', (ctx: Context) => {
  prunePending()
  const port = process.env.PORT || '3000'
  const callbackUrl = `http://127.0.0.1:${port}/auth/callback`

  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('hex')
  pending.set(state, { verifier, createdAt: Date.now(), callbackUrl })

  const url = new URL(authOrigin() + '/')
  url.searchParams.set('returnPath', callbackUrl)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)

  openBrowser(url.toString())
  ctx.body = { url: url.toString(), state, expiresIn: PENDING_TTL_MS / 1000 }
})

/**
 * Loopback redirect target. Lives outside /api on purpose: the browser arrives
 * here directly, and this must stay reachable even before anyone is signed in.
 */
accountRouter.get('/auth/callback', async (ctx: Context) => {
  const code = typeof ctx.query.code === 'string' ? ctx.query.code : ''
  const state = typeof ctx.query.state === 'string' ? ctx.query.state : ''
  const denied = typeof ctx.query.error === 'string' ? ctx.query.error : ''

  if (denied) return htmlPage(ctx, 400, '登录未完成', '你在授权页面取消了登录。可以回到 SUPERCRZY BOT 重试。')

  const entry = state ? pending.get(state) : undefined
  if (!entry || !state) {
    return htmlPage(ctx, 400, '登录链接无效', '这个链接已失效或不是本机发起的。请回到 SUPERCRZY BOT 重新点击登录。')
  }
  // Single use, even if the exchange below fails — a replay must not work.
  pending.delete(state)
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    return htmlPage(ctx, 400, '登录超时', '这次登录等待太久了，请回到 SUPERCRZY BOT 重新发起。')
  }
  if (!code) return htmlPage(ctx, 400, '登录链接不完整', '缺少授权码，请回到 SUPERCRZY BOT 重试。')

  try {
    const res = await fetch(authOrigin() + '/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, codeVerifier: entry.verifier }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.warn('[account] exchange failed', res.status, detail.slice(0, 200))
      return htmlPage(ctx, 400, '登录未通过', '授权码校验失败，请回到 SUPERCRZY BOT 重新登录。')
    }
    const data = (await res.json()) as {
      accessToken?: string
      refreshToken?: string
      expiresIn?: number
      account?: { id?: string; email?: string }
      device?: { id?: string }
    }
    if (!data.accessToken || !data.refreshToken || !data.account?.id) {
      return htmlPage(ctx, 400, '登录未通过', '服务端返回的数据不完整，请稍后重试。')
    }
    writeSession({
      accountId: data.account.id,
      email: data.account.email || '',
      deviceId: data.device?.id || '',
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: Date.now() + (data.expiresIn ?? 900) * 1000,
      savedAt: Date.now(),
    })
    console.log('[account] signed in as', data.account.email)
    return htmlPage(ctx, 200, '登录成功', '可以关闭这个窗口，回到 SUPERCRZY BOT。')
  } catch (err) {
    console.warn('[account] exchange error', (err as Error).message)
    return htmlPage(ctx, 400, '登录未通过', '网络异常，请回到 SUPERCRZY BOT 重试。')
  }
})

accountRouter.get('/api/account/status', (ctx: Context) => {
  const s = readSession()
  const signedIn = isSignedIn()
  ctx.body = {
    signedIn,
    email: signedIn ? s!.email : '',
    accountId: signedIn ? s!.accountId : '',
    expiresAt: signedIn ? s!.expiresAt : 0,
  }
})

accountRouter.post('/api/account/logout', async (ctx: Context) => {
  const s = readSession()
  if (s?.refreshToken) {
    // Best effort: local state is dropped regardless of what the server says.
    try {
      await fetch(authOrigin() + '/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: s.refreshToken }),
      })
    } catch {
      /* offline sign-out is still a sign-out */
    }
  }
  clearSession()
  ctx.body = { ok: true }
})

