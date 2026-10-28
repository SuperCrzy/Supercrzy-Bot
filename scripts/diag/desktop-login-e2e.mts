/**
 * End-to-end check of the desktop sign-in handshake, without a real browser:
 * start → OTP on the real auth service → mock the redirect the portal would do
 * → the loopback callback exchanges the code → session lands on disk.
 *
 * Run with: SC_AUTH_DIR=/tmp/sc-auth-e2e SUPERCRZY_AUTH_ORIGIN=http://127.0.0.1:3010 PORT=3999 tsx this.ts
 */
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import { readFileSync } from 'node:fs'
import { accountRouter } from '../../packages/server/src/routes/account'
import { readSession, clearSession } from '../../packages/server/src/services/account-store'

const AUTH = process.env.SUPERCRZY_AUTH_ORIGIN!
const PORT = Number(process.env.PORT || 3999)

function otpCodeFor(email: string): string {
  const log = readFileSync('/tmp/auth-preview.log', 'utf8')
  const re = new RegExp('OTP for ' + email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' — (\\d{6})', 'g')
  const codes = [...log.matchAll(re)].map((m) => m[1])
  if (!codes.length) throw new Error('no OTP in mailer log for ' + email)
  return codes[codes.length - 1]
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  clearSession()
  process.env.SC_AUTH_DIR = process.env.SC_AUTH_DIR || '/tmp/sc-auth-e2e'

  const app = new Koa()
  app.use(bodyParser())
  app.use(accountRouter.routes()).use(accountRouter.allowedMethods())
  const server = app.listen(PORT)
  await sleep(300)
  const base = `http://127.0.0.1:${PORT}`
  const results: Record<string, unknown> = {}

  // 1. status before login
  results.before = await (await fetch(base + '/api/account/status')).json()

  // 2. start: gives us the authorize URL containing challenge + state
  const start = await (await fetch(base + '/api/account/login/start', { method: 'POST' })).json()
  const authUrl = new URL(start.url)
  const challenge = authUrl.searchParams.get('code_challenge')
  const state = authUrl.searchParams.get('state')
  const returnPath = authUrl.searchParams.get('returnPath')
  results.start = { returnPath, hasChallenge: !!challenge, challengeLen: challenge?.length, stateLen: state?.length }

  // 3. play the portal: OTP login carrying the challenge
  const email = `bot-e2e-${Date.now()}@example.com`
  await fetch(AUTH + '/auth/otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, deviceName: 'SUPERCRZY BOT', devicePlatform: 'mac' }),
  })
  await sleep(1000)
  const code = otpCodeFor(email)
  const verifyRes = await fetch(AUTH + '/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      code,
      deviceName: 'SUPERCRZY BOT',
      devicePlatform: 'mac',
      returnPath,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    }),
  })
  const verify = await verifyRes.json()
  results.verify = { status: verifyRes.status, redirect: verify.redirect, hasExchangeCode: !!verify.exchangeCode }

  // 4. the browser lands on the loopback callback with code + state
  const cbUrl = `${verify.redirect}?code=${encodeURIComponent(verify.exchangeCode)}&state=${state}`
  const cb = await fetch(cbUrl)
  const cbHtml = await cb.text()
  results.callback = { status: cb.status, ok: cbHtml.includes('登录成功') }

  // 5. session must now be readable and encrypted on disk
  const after = await (await fetch(base + '/api/account/status')).json()
  results.after = after
  const session = readSession()
  results.session = session
    ? { email: session.email, hasAccess: !!session.accessToken, hasRefresh: !!session.refreshToken, expiresIn: Math.round((session.expiresAt - Date.now()) / 1000) }
    : null
  const raw = readFileSync(`${process.env.SC_AUTH_DIR}/auth.json`, 'utf8')
  results.fileIsEncrypted = !raw.includes('refreshToken') && !raw.includes(email)

  // 6. replaying the same callback must fail (state already consumed)
  const replay = await fetch(cbUrl)
  results.replay = { status: replay.status, rejected: (await replay.text()).includes('无效') }

  // 7. bad state must fail
  const bogus = await fetch(`${verify.redirect}?code=x&state=deadbeef`)
  results.badState = { status: bogus.status, rejected: (await bogus.text()).includes('无效') }

  // 8. logout clears everything
  await fetch(base + '/api/account/logout', { method: 'POST' })
  results.afterLogout = await (await fetch(base + '/api/account/status')).json()

  console.log(JSON.stringify(results, null, 2))
  server.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('FAILED', e)
  process.exit(1)
})
