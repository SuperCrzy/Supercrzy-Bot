/**
 * 会话式朗读（2026-10-21）—— **一条消息 = 一条 TTS 流**。
 *
 * 为什么要它：旧实现是「客户端按 60/600 字切段 → 每段一次独立请求 → 每段一个独立编码的
 * mp3 → 每段一个 `<audio>` 接力」。固定成本（ws 握手 + mp3 编码器起头）按段数重复，
 * 手机实测每段首字节 **7.5~10.6s**，于是长回复中间夹着几十秒静音（"卡壳"）。
 *
 * 本模块把协议面的能力用足（均已实测，见 tts.ts 的注释）：
 *   · 上游**同一条 ws 连接可以连续多轮合成** —— 每轮换一个 `X-RequestId` 即可
 *   · 上游对空闲连接很宽容（实测 20s / 45s 空闲后仍可继续）
 *   · 96kbps mp3 是**无 ID3 头的纯帧流**（首 4 字节 `fff3`）⇒ 多轮音频可以直接拼成
 *     一条连续 mp3 流交给浏览器播
 *
 * 于是：握手每条消息只付一次；客户端拿到的是一个**永不中断的 mp3 流**，
 * 段与段之间没有编码器重置，也就没有缝。
 *
 * 🔴 与 DeepSeek 方案的差异：他们用 AudioTrack + PCM + 自己的 prebuffer/underrun 恢复；
 * 浏览器里 `<audio>` 播 chunked mp3 天然带缓冲（电台模式），所以我们不需要 PCM 那层。
 * 少一层就少一处能坏的地方。
 */
import { randomBytes } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { invalidateRoute } from './tts-route-state'
import { pickTtsRoute } from './tts-route'
import {
  openUpstream,
  speechConfigFrame,
  ssmlFrame,
  takeWarmConnection,
  prewarmTts,
  TTS_OUTPUT_FORMAT,
  formatForQuality,
  TTS_FIRST_CHUNK_TIMEOUT_MS,
  TTS_STREAM_STALL_TIMEOUT_MS,
  defaultVoice,
  type UpstreamSocket,
} from './tts'

/** 单次 push 的文本上限（超过让调用方自己切，否则一轮合成太久、首包变慢） */
export const LIVE_MAX_CHARS_PER_PUSH = 1000
/** 一条会话的累计文本上限（防"粘着不结束"的会话把上游当免费算力） */
export const LIVE_MAX_CHARS_TOTAL = 40_000
/** 队列空后多久关掉上游连接（会话本身还活着，下次 push 再连） */
export const LIVE_CONNECTION_IDLE_MS = 90_000
/** 单轮失败重试次数（连接被上游关掉时靠它续上） */
export const LIVE_TURN_RETRIES = 2

const AUDIO_SEP = 'Path:audio\r\n'

type TurnResult = { bytes: number }

/**
 * 一条朗读会话。
 *
 * 生命周期：`push()` 若干次 → `end()` → 尾部音频写完 → `out` 结束。
 * 中途任何一步失败都只会让**当前这轮**失败；整条流是否继续由调用方（路由）决定，
 * 但对客户端而言它始终是同一个响应体 —— 断流后重连补上的音频会接着写，听感是连续的。
 */
export class LiveTtsSession {
  readonly id = randomBytes(24).toString('hex')
  /** 交给路由 pipe 给 HTTP 响应；从创建那一刻就存在，早到的音频会先缓冲在里面 */
  readonly out = new PassThrough({ highWaterMark: 64 * 1024 })

  private readonly voice?: string
  private readonly rate?: string
  /** 本会话的 outputFormat（96k / 48k；弱网走 48k） */
  private readonly format: string
  private sock: UpstreamSocket | null = null
  private connectionId = ''
  /** 捡来的预热连接已经发过 speech.config，不能再发一遍 */
  private preConfigured = false
  private queue: string[] = []
  /** 最近一次致命错误（诊断用；流已经开了就改不了状态码） */
  lastError: Error | null = null
  private busy = false
  private ended = false
  private destroyed = false
  /** Whether this session hit an unrecoverable synthesis failure (drives the status endpoint and
   *  the client's "interrupted / resume" path) */
  private failed = false
  private charsTotal = 0
  private bytesTotal = 0
  private idleTimer: NodeJS.Timeout | null = null
  private createdAt = Date.now()

  constructor(opts: { voice?: string; rate?: string; quality?: unknown } = {}) {
    this.voice = opts.voice
    this.rate = opts.rate
    this.format = formatForQuality(opts.quality) ?? TTS_OUTPUT_FORMAT
  }

  get isEnded(): boolean { return this.ended }
  get isDestroyed(): boolean { return this.destroyed }
  get isFailed(): boolean { return this.failed }
  get ageMs(): number { return Date.now() - this.createdAt }
  get sentBytes(): number { return this.bytesTotal }

  /** 追加一段文本；空文本忽略。返回 false 表示会话已结束/已销毁 */
  push(text: string): boolean {
    const t = String(text || '').trim()
    if (!t) return true
    if (this.ended || this.destroyed) return false
    if (t.length > LIVE_MAX_CHARS_PER_PUSH) {
      // 超长就自己切开，而不是丢掉 —— 丢掉等于静音一段内容
      for (let i = 0; i < t.length; i += LIVE_MAX_CHARS_PER_PUSH) {
        const part = t.slice(i, i + LIVE_MAX_CHARS_PER_PUSH)
        if (!this.enqueue(part)) return false
      }
      return true
    }
    return this.enqueue(t)
  }

  private enqueue(t: string): boolean {
    if (this.charsTotal + t.length > LIVE_MAX_CHARS_TOTAL) {
      // 到上限就收尾，别让会话无限长
      this.end()
      return false
    }
    this.charsTotal += t.length
    this.queue.push(t)
    this.clearIdle()
    void this.pump().catch(() => { /* pump 内部已兜住 */ })
    return true
  }

  /** 没有更多文本了：队列播空后结束整条流 */
  end(): void {
    if (this.ended) return
    this.ended = true
    void this.pump().catch(() => { /* pump 内部已兜住 */ })
  }

  /** 强行销毁（路由在客户端断开 / 超时清理时调用） */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.clearIdle()
    this.closeSocket()
    try { this.out.end() } catch { /* 已关闭 */ }
  }

  // ===== 内部 =====

  private clearIdle() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
  }

  /** 队列空 → 连接闲置一段时间就关掉（会话还在，下次 push 重连，能从预热池拿就更快） */
  private armIdleClose() {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.busy && this.queue.length === 0) this.closeSocket()
    }, LIVE_CONNECTION_IDLE_MS)
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref()
  }

  private closeSocket() {
    const s = this.sock
    this.sock = null
    this.preConfigured = false
    if (s) { try { s.close() } catch { /* 已关 */ } }
    prewarmTts()
  }

  private async ensureSocket(): Promise<UpstreamSocket> {
    if (this.sock) return this.sock
    const w = takeWarmConnection(this.format)
    if (w) {
      this.sock = w.sock
      this.connectionId = w.connectionId
      this.preConfigured = true
      return this.sock
    }
    this.connectionId = randomBytes(16).toString('hex')
    const sock = await openUpstream(this.connectionId)
    this.sock = sock
    this.preConfigured = false
    return sock
  }

  private async pump(): Promise<void> {
    if (this.busy || this.destroyed) return
    this.busy = true
    try {
      for (;;) {
        if (this.destroyed) return
        const text = this.queue.shift()
        if (!text) {
          if (this.ended) return
          this.armIdleClose()
          return
        }
        await this.runTurnWithRetry(text)
      }
    } catch (e: any) {
      // 🔴 这里**绝对不能 throw**：pump 是以 `void this.pump().catch(() => { /* pump 内部已兜住 */ })` 起的（没人 await），
      // 抛出去就是 unhandledRejection —— 实机日志里刷屏的就是这个。
      // 头已经发出去了，改不了状态码；能做的是收尾 + 记下来供诊断。
      // 🔴 failed must be set: after out.end() the client's <audio> receives a **normal `ended`
      //    event** while holding only half the content — without this flag the client always
      //    believes the reading finished (a dropped tail is invisible).
      this.failed = true
      this.lastError = e instanceof Error ? e : new Error(String(e))
      // 失败 ⇒ 把出口判定作废并**立即重测一次**（可能该换中继了）。
      // 不重测的话这条失效只是躺在那儿，下一次朗读还是会走原来的死路。
      invalidateRoute()
      void pickTtsRoute().catch(() => { /* 探测失败不影响已结束的会话 */ })
      try { this.out.end() } catch { /* 已关闭 */ }
      this.closeSocket()
    } finally {
      this.busy = false
      if (this.ended && !this.destroyed && this.queue.length === 0) {
        // 队列已空且不再有新文本 → 正常收尾（客户端 <audio> 会收到 ended）
        this.closeSocket()
        try { this.out.end() } catch { /* 已关闭 */ }
      }
    }
  }

  private async runTurnWithRetry(text: string): Promise<TurnResult> {
    let lastErr: Error = new Error('朗读失败')
    for (let attempt = 0; attempt <= LIVE_TURN_RETRIES; attempt++) {
      try {
        return await this.runTurn(text)
      } catch (e: any) {
        lastErr = e instanceof Error ? e : new Error(String(e))
        // 🔴 This turn already wrote audio bytes ⇒ resending the same text means **doubled audio**
        //    (reproduced in a unit test: stream break after 8192 bytes → retry → 16384, the same
        //    content played twice). "writtenBytes > 0" can only mean a mid-stream break, which a
        //    retry cannot fix — give up and let pump set failed so the client can resume.
        if (Number((e as any)?.writtenBytes || 0) > 0) throw lastErr
        // Connection broke before any byte was written → drop it, reconnect and resend (safe)
        this.closeSocket()
        if (attempt < LIVE_TURN_RETRIES) {
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
        }
      }
    }
    throw lastErr
  }

  /** 合成一轮：发 ssml → 攒音频 → turn.end 时落盘 */
  private runTurn(text: string): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve, reject) => {
      let settled = false
      let pending = Buffer.alloc(0)
      let bytes = 0
      let timer: NodeJS.Timeout | null = null
      let sock: UpstreamSocket | null = null

      const finish = (e?: Error) => {
        if (settled) return
        settled = true
        if (timer) { clearTimeout(timer); timer = null }
        this.out.off('close', onClose)
        if (e) {
          // Attach "how many bytes this turn already wrote" to the error — runTurnWithRetry uses
          // it to tell a safe-to-resend connection failure (nothing played yet) apart from a
          // mid-stream break (a resend would double the audio)
          ;(e as any).writtenBytes = bytes
          reject(e)
        } else {
          resolve({ bytes })
        }
      }
      // Playback side closed (destroy → out close) ⇒ abort this turn immediately:
      // 1. stop pulling audio nobody listens to; 2. previously only the stall timeout caught
      // this (30s of dead wait)
      const onClose = () => finish(new Error('播放端已断开'))
      this.out.once('close', onClose)
      const arm = (ms: number, msg: string) => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => finish(new Error(msg)), ms)
        if (typeof timer.unref === 'function') timer.unref()
      }

      const write = (buf: Buffer) => {
        if (!buf.length) return
        bytes += buf.length
        this.bytesTotal += buf.length
        if (!this.out.write(buf)) {
          // Downstream can't keep up (client paused / slow network) → pause upstream until drain.
          // 🔴 The stall timer **must be suspended during backpressure**: a client paused for
          // longer than 30s (the stall threshold) does not mean "upstream died". The timer used to
          // keep running → a pause long enough was misread as a failure → the same audio was
          // resent and played twice.
          try { sock?.pause() } catch { /* 已关 */ }
          if (timer) { clearTimeout(timer); timer = null }
          this.out.once('drain', () => {
            try { sock?.resume() } catch { /* 已关 */ }
            if (!settled) arm(TTS_STREAM_STALL_TIMEOUT_MS, '上游数据中断')
          })
        }
      }

      void (async () => {
        try {
          const s = await this.ensureSocket()
          sock = s
          if (!this.preConfigured) {
            s.send(speechConfigFrame(this.connectionId, this.format))
            this.preConfigured = true
          }
          if (settled) return
          arm(TTS_FIRST_CHUNK_TIMEOUT_MS, '首块超时')

          s.on('message', (data: any, isBinary: boolean) => {
            if (settled) return
            if (isBinary) {
              const at = data.indexOf(AUDIO_SEP)
              // 找不到分隔符时**整帧当音频**：indexOf 返回 -1 会静默吃掉前 11 字节
              pending = Buffer.concat([pending, at >= 0 ? data.subarray(at + AUDIO_SEP.length) : data])
              arm(TTS_STREAM_STALL_TIMEOUT_MS, '上游数据中断')
              if (pending.length >= 4096) {
                const out = pending
                pending = Buffer.alloc(0)
                write(out)
              }
              return
            }
            if (data.toString().includes('Path:turn.end')) {
              if (pending.length) { write(pending); pending = Buffer.alloc(0) }
              finish()
            }
          })
          s.on('close', (code?: number, reason?: Buffer) => {
            const detail = reason && reason.length ? `${code} ${reason.toString()}` : String(code ?? '?')
            finish(new Error(`上游提前关闭连接（code=${detail}）`))
          })
          s.on('error', (e: any) => finish(e instanceof Error ? e : new Error(String(e))))

          // 每轮一个全新的 X-RequestId（必须是 32 位无横线 UUID，否则上游 1002 直接关连接）
          s.send(ssmlFrame(randomBytes(16).toString('hex'), text, liveVoice(this.voice), liveLang(this.voice), this.rate || 'default'))
        } catch (e: any) {
          finish(e instanceof Error ? e : new Error(String(e)))
        }
      })()
    })
  }
}

/** 音色/语种都取 tts.ts 的唯一来源，别在这里再抄一份默认值 */
function liveVoice(voice?: string): string {
  return voice || defaultVoice()
}

function liveLang(voice?: string): string {
  return liveVoice(voice).startsWith('zh') ? 'zh-CN' : 'en-US'
}
