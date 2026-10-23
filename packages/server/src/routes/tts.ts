import Router from 'koa-router'
import type { Context } from 'koa'
import { PassThrough } from 'node:stream'
import { randomBytes } from 'node:crypto'
import {
  synthesizeSpeech,
  synthesizeSpeechStream,
  TTS_VOICES,
  defaultVoice,
  TTS_MAX_CHARS,
} from '../services/tts'
import { LiveTtsSession, LIVE_MAX_CHARS_PER_PUSH } from '../services/tts-session'
import { formatForQuality, TTS_FORMATS } from '../services/tts'
import { pickTtsRoute, routeSnapshot } from '../services/tts-route'

/**
 * TTS API — AI 回复朗读的高质量音色通道（2026-09-27）。
 * 供前端 useSpeech 的 Pro 档调用：
 * - GET  /api/tts/voices   → 可选音色清单（设置项）
 * - POST /api/tts          → { text, voice?, rate? } → audio/mpeg（**整包**，等合成完）
 * - POST /api/tts/ticket   → { text, voice?, rate? } → { token }（流式一次性票据）
 * - GET  /api/tts/stream?t → 边合成边下发 audio/mpeg（**chunked**，2026-09-28）
 *
 * 为什么必须有 `/stream`（而不是继续用 `/`）：
 *   `/` 的响应体是完整 mp3 ⇒ **首声 = 整包合成时长**。实测 1596 字整包要 2.6~18.9s，
 *   而上游**首块只要 335~602ms**（与文本长度无关，见 services/tts.ts 的实测表）。
 *   `/stream` 把上游的流直接转给 `<audio>`，首声落到 ~0.7s。
 *   `/` 保留给设置页试听（短文本，无所谓）与流式朗读的单块请求。
 *
 * 为什么要"票据 + GET"两段式：`<audio src="...">` **无法携带自定义请求头**，
 * 所以不能把文本放在 POST body 里直接流给播放器。文本先换成一次性 token，播放器只拿 token 去 GET。
 * 🔴 相应地 `/api/tts/stream` 必须在 app.ts 的鉴权中间件里**豁免** —— 安全性由这个
 *   高熵、短时效、限次数的 token 承担（见下方不变量）。
 */
export const ttsRouter = new Router({ prefix: '/api/tts' })

// ===== 流式票据 =====
//
// 不变量（都刻意写死，改动前先想清楚为什么）：
//   ① **高熵**：24 字节随机 → 48 位 hex。不可猜，不然等于把朗读接口对公网敞开。
//   ② **短时效**：60s。票据只在"用户点了朗读 → 播放器立刻来取"这个窗口内需要存在。
//   ③ **限次数**：5 次。正常只会被取 1 次；留余量给媒体播放器可能的重取，
//      同时挡住"拿一个 token 反复打上游"这种放大。
//   ④ **有界**：最多 32 条，超出按最旧淘汰。没有这条，长时间挂机就是内存泄漏。

interface Ticket {
  text: string
  voice?: string
  rate?: string
  createdAt: number
  uses: number
}

const TICKET_TTL_MS = 60_000
const TICKET_MAX = 32
const TICKET_MAX_USES = 5
const TOKEN_RE = /^[0-9a-f]{48}$/

const tickets = new Map<string, Ticket>()

function sweepTickets(now: number): void {
  for (const [k, v] of tickets) {
    if (now - v.createdAt > TICKET_TTL_MS) tickets.delete(k)
  }
}

function issueTicket(text: string, voice?: string, rate?: string): string {
  const now = Date.now()
  sweepTickets(now)
  while (tickets.size >= TICKET_MAX) {
    let oldestKey: string | null = null
    let oldestAt = Infinity
    for (const [k, v] of tickets) {
      if (v.createdAt < oldestAt) { oldestAt = v.createdAt; oldestKey = k }
    }
    if (!oldestKey) break
    tickets.delete(oldestKey)
  }
  const token = randomBytes(24).toString('hex')
  tickets.set(token, { text, voice, rate, createdAt: now, uses: 0 })
  return token
}

/**
 * 取票据。**格式不合法直接拒**（不查表）——
 * 否则任何人都能拿任意字符串打这个接口来观测"404 快还是 200 快"的时间差。
 */
function takeTicket(token: unknown): Ticket | null {
  const t = String(token || '')
  if (!TOKEN_RE.test(t)) return null
  const rec = tickets.get(t)
  if (!rec) return null
  if (Date.now() - rec.createdAt > TICKET_TTL_MS) { tickets.delete(t); return null }
  if (rec.uses >= TICKET_MAX_USES) { tickets.delete(t); return null }
  rec.uses += 1
  return rec
}

ttsRouter.get('/voices', (ctx: Context) => {
  ctx.body = { voices: TTS_VOICES, default: defaultVoice(), maxChars: TTS_MAX_CHARS }
})

/** 校验朗读入参，返回错误文案（null = 通过）。整包与流式两条路共用，口径不能分叉 */
function validateText(raw: unknown): { text: string; error: string | null } {
  const text = String(raw || '')
  if (!text.trim()) return { text, error: 'text 不能为空' }
  if (text.trim().length > TTS_MAX_CHARS) {
    return { text, error: `文本过长（${text.trim().length} 字 > ${TTS_MAX_CHARS}），请分句请求` }
  }
  return { text, error: null }
}

ttsRouter.post('/', async (ctx: Context) => {
  const { text, voice, rate } = (ctx.request.body as any) || {}
  const { text: body, error } = validateText(text)
  if (error) {
    ctx.status = 400
    ctx.body = { error }
    return
  }
  try {
    const buf = await synthesizeSpeech(body, { voice, rate })
    ctx.type = 'audio/mpeg'
    ctx.set('Cache-Control', 'no-store')
    ctx.body = buf
  } catch (e: any) {
    // 502 而不是 400：这是**上游合成服务**失败（实测多为握手被 RST），不是请求本身有问题。
    // 早先回 400 会让人以为"参数写错了/服务下线了"，把排查方向整个带偏（2026-09-28）。
    ctx.status = 502
    ctx.body = { error: `语音合成失败: ${e?.message || e}` }
  }
})

/** 换票：只校验 + 存文本，**不在这里开始合成**（合成由播放器那次 GET 触发） */
ttsRouter.post('/ticket', (ctx: Context) => {
  const { text, voice, rate } = (ctx.request.body as any) || {}
  const { text: body, error } = validateText(text)
  if (error) {
    ctx.status = 400
    ctx.body = { error }
    return
  }
  ctx.set('Cache-Control', 'no-store')
  ctx.body = { token: issueTicket(body.trim(), voice, rate) }
})

ttsRouter.get('/stream', async (ctx: Context) => {
  const rec = takeTicket((ctx.query as any)?.t)
  if (!rec) {
    // 410 而不是 404：票据**存在过但已失效**（过期/用尽），前端据此提示"重按一次朗读"
    ctx.status = 410
    ctx.body = { error: '朗读链接已失效，请重新点一次朗读' }
    return
  }

  // 用 PassThrough 交给 Koa 去 pipe，而不是 `ctx.respond = false` 手工接管。
  // 理由：Koa 对 Stream body 本来就不缓冲（只 pipe，且不会设 Content-Length ⇒ 自动 chunked），
  // 而且这样 cors 等中间件的"next 之后"逻辑仍能正常写头 —— 手工接管会和它们抢写头。
  const out = new PassThrough()
  // 客户端断开时 out.destroy() 可能让 pipe 那一侧抛出；这里兜住，避免变成 uncaught 'error' 打崩进程
  out.on('error', () => { /* 已由 clientGone 分支处理 */ })
  let clientGone = false
  ctx.res.on('close', () => {
    clientGone = true
    // 客户端（用户点了停止 / 关页面）断开 ⇒ 掐断下游。
    // 不做这一步：pt.write 会一直返回 false，onChunk 永远等 drain，上游 ws 就白挂着拉完几 MB。
    out.destroy()
  })

  let firstArrived = false
  let resolveFirst: () => void = () => {}
  const firstChunk = new Promise<void>((r) => { resolveFirst = r })
  let failure: Error | null = null

  const pump = synthesizeSpeechStream(rec.text, { voice: rec.voice, rate: rec.rate }, (buf) => {
    if (clientGone) throw new Error('客户端已断开')
    if (!firstArrived) { firstArrived = true; resolveFirst() }
    // 返回 Promise 就把反压交给上游：services/tts.ts 见到 thenable 会 pause socket，
    // drain 之后再 resume —— 否则这段音频会在 Node 内存里堆成整包，"流式"就白做了。
    if (out.write(buf)) return
    return waitWritable(out)
  })
    .catch((e: any) => { failure = e instanceof Error ? e : new Error(String(e)) })
    .finally(() => { if (!out.writableEnded && !out.destroyed) out.end() })

  // 必须先知道"首块到了没有"再决定状态码：首块之前失败还能回 502，
  // 首块之后已经不可能改状态码了（响应头已发出）。
  await Promise.race([firstChunk, pump])
  // `failure` 只在回调里被赋值，TS 的控制流分析看不到 ⇒ 在这里会被窄化成 null。
  // 显式回宽一次，别为此把变量改成 any。
  const failed = failure as Error | null
  if (failed || !firstArrived) {
    await pump
    ctx.status = 502
    ctx.body = { error: `语音合成失败: ${failed?.message || '未收到音频'}` }
    return
  }

  ctx.type = 'audio/mpeg'
  ctx.set('Cache-Control', 'no-store')
  // nginx 默认会缓冲代理响应 —— 那会把这里的流又攒回整包，等于白改。
  // 走 <audio> 的请求浏览器不会带 Origin 之外的凭据，这里放开跨源以免 PWA 子路径部署被挡。
  ctx.set('X-Accel-Buffering', 'no')
  const origin = ctx.request.header.origin
  ctx.set('Access-Control-Allow-Origin', origin || '*')
  ctx.body = out
})

/**
 * ===== 会话式朗读（2026-10-21）=====
 *
 * `POST /api/tts/live`      → { token }（一条消息一条流）
 * `POST /api/tts/live/push` → { t, text } 追加一段文本（模型还在生成时随时调）
 * `POST /api/tts/live/end`  → { t } 没有更多文本了
 * `GET  /api/tts/live/stream?t=...` → 连续的 audio/mpeg（chunked，永不换连接）
 *
 * 为什么不是"每段一次请求"：那等于把 ws 握手与 mp3 编码器起头按段数重复付（手机 7~10s/段）。
 * 上游本身支持一条连接连续多轮合成（实测空闲 45s 仍可用），所以整条回复只用一条流。
 */
const LIVE_TTL_MS = 30 * 60_000
const LIVE_IDLE_DROP_MS = 10 * 60_000
const LIVE_MAX_SESSIONS = 8

interface LiveEntry { s: LiveTtsSession; lastAt: number }
const liveSessions = new Map<string, LiveEntry>()

function sweepLive(now: number): void {
  for (const [k, v] of liveSessions) {
    const dead = v.s.isEnded || v.s.isDestroyed || now - v.lastAt > LIVE_IDLE_DROP_MS || v.s.ageMs > LIVE_TTL_MS
    if (dead) {
      v.s.destroy()
      liveSessions.delete(k)
    }
  }
}

function takeLive(token: unknown): LiveTtsSession | null {
  const t = String(token || '')
  if (!TOKEN_RE.test(t)) return null
  const e = liveSessions.get(t)
  if (!e) return null
  e.lastAt = Date.now()
  return e.s
}

/**
 * 出口自检（2026-10-21）：告诉客户端/运维"现在走直连还是中继、各自握手多少毫秒"。
 * 没有它，选路就是个黑盒 —— 出问题时只能猜。
 */
ttsRouter.get('/route', (ctx: Context) => {
  ctx.set('Cache-Control', 'no-store')
  ctx.body = routeSnapshot()
})

ttsRouter.post('/route/refresh', async (ctx: Context) => {
  const d = await pickTtsRoute(true)
  ctx.set('Cache-Control', 'no-store')
  ctx.body = { chosen: d.proxy ?? 'direct', ms: d.ms, probes: d.probes }
})

ttsRouter.post('/live', (ctx: Context) => {
  const { voice, rate, quality } = (ctx.request.body as any) || {}
  // 码率档（2026-10-21）：'96' 默认 / '48' 弱网。非法值直接 400，别静默回默认 ——
  // 否则弱网用户会以为"降码率没生效"，而实际上是参数写错了。
  if (quality !== undefined && formatForQuality(quality) === null) {
    ctx.status = 400
    ctx.body = { error: `quality 只支持 ${Object.keys(TTS_FORMATS).join(' / ')}` }
    return
  }
  const now = Date.now()
  sweepLive(now)
  // 有界：超出按最久未活动淘汰（防止挂机把上游连接堆满）
  while (liveSessions.size >= LIVE_MAX_SESSIONS) {
    let oldestKey: string | null = null
    let oldestAt = Infinity
    for (const [k, v] of liveSessions) {
      if (v.lastAt < oldestAt) { oldestAt = v.lastAt; oldestKey = k }
    }
    if (!oldestKey) break
    liveSessions.get(oldestKey)?.s.destroy()
    liveSessions.delete(oldestKey)
  }
  const s = new LiveTtsSession({
    voice: typeof voice === 'string' ? voice : undefined,
    rate: typeof rate === 'string' ? rate : undefined,
    quality,
  })
  liveSessions.set(s.id, { s, lastAt: now })
  ctx.set('Cache-Control', 'no-store')
  ctx.body = {
    token: s.id,
    url: `/api/tts/live/stream?t=${s.id}`,
    maxCharsPerPush: LIVE_MAX_CHARS_PER_PUSH,
  }
})

ttsRouter.post('/live/push', (ctx: Context) => {
  const { t, text } = (ctx.request.body as any) || {}
  const s = takeLive(t)
  if (!s) {
    ctx.status = 410
    ctx.body = { error: '朗读会话已失效' }
    return
  }
  // A finished session accepts no more pushes (409 instead of 200 {ok:false}) — the old code
  // silently swallowed "pushes that arrived after end", so the client never noticed and the tail
  // was simply lost. An explicit 409 lets the caller tell "accepted" from "discarded"; together
  // with the client's serialized push queue this path should not be reachable any more.
  if (s.isEnded || s.isDestroyed) {
    ctx.status = 409
    ctx.body = { ok: false, error: '朗读会话已结束，push 被拒绝' }
    return
  }
  const { text: body, error } = validateText(text)
  if (error) {
    ctx.status = 400
    ctx.body = { error }
    return
  }
  const ok = s.push(body.trim())
  ctx.set('Cache-Control', 'no-store')
  ctx.body = { ok }
})

ttsRouter.post('/live/end', (ctx: Context) => {
  const { t } = (ctx.request.body as any) || {}
  const s = takeLive(t)
  if (!s) {
    ctx.status = 410
    ctx.body = { error: '朗读会话已失效' }
    return
  }
  s.end()
  ctx.set('Cache-Control', 'no-store')
  ctx.body = { ok: true }
})

/**
 * Session status — queried by the client after endLive.
 *
 * Why it is required: when synthesis fails mid-way the server calls `out.end()`, so the client's
 * `<audio>` receives an **ended event identical to a normal finish** — "it read half and stopped"
 * is completely invisible on the client. `failed` is the only reliable evidence of a dropped tail,
 * and the client uses it to show "interrupted / resume".
 *
 * 410 means the session no longer exists. The sweeper only reclaims sessions that are "ended /
 * destroyed / idle for long", so **failed sessions stay in the table** (ended not set) until the
 * idle timeout — therefore, querying right after end means 410 ⇒ "finished normally", not "failed".
 */
ttsRouter.get('/live/status', (ctx: Context) => {
  const s = takeLive((ctx.query as any)?.t)
  if (!s) {
    ctx.status = 410
    ctx.body = { error: '朗读会话已失效' }
    return
  }
  ctx.set('Cache-Control', 'no-store')
  ctx.body = {
    failed: s.isFailed,
    ended: s.isEnded,
    destroyed: s.isDestroyed,
    sentBytes: s.sentBytes,
  }
})

ttsRouter.get('/live/stream', async (ctx: Context) => {
  const s = takeLive((ctx.query as any)?.t)
  if (!s) {
    ctx.status = 410
    ctx.body = { error: '朗读链接已失效，请重新点一次朗读' }
    return
  }
  // 客户端断开 → 整条会话作废（否则上游会继续合成没人听的音频）
  ctx.res.on('close', () => { s.destroy() })
  ctx.type = 'audio/mpeg'
  ctx.set('Cache-Control', 'no-store')
  // 与 /stream 同理：nginx 默认缓冲会把流攒成整包，等于白改
  ctx.set('X-Accel-Buffering', 'no')
  const origin = ctx.request.header.origin
  ctx.set('Access-Control-Allow-Origin', origin || '*')
  ctx.body = s.out
})

/**
 * 等下游把缓冲写出去（反压）。
 *
 * 🔴 必须**同时**听 `close`：`ctx.res.on('close')` 里那一句 `out.destroy()` 之后
 * `drain` **永远不会再来** —— 只等 drain 的话这个 Promise 就永久挂住，连带
 * `streamOnce` 里的 `socket.pause()` 永不恢复、上游 ws 永不关闭。
 * 症状是"点朗读 → 立刻点停止"每来一次就漏一个上游 socket + 一份缓冲，
 * 而请求早已结束、日志里一点痕迹都没有。
 */
export function waitWritable(stream: PassThrough): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      stream.off('drain', done)
      stream.off('close', done)
      resolve()
    }
    stream.once('drain', done)
    stream.once('close', done)
  })
}
