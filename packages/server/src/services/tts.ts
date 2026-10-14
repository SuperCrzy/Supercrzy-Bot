/**
 * Edge TTS 语音合成服务（2026-09-27）。
 *
 * 为什么用它：Web Speech API（系统 TTS）是拼接式音色，机械感强；Edge TTS 是微软神经网络
 * 音色（zh-CN-XiaoxiaoNeural 等），接近真人。
 *
 * ⚠️ **更正（2026-09-28）**：早先本注释写"国内直连可达（~0.5s 握手）"是**错的** ——
 * 实测该主机的 wss 握手在本机网络约 **3/4 次数**被中间盒 RST（详见 isTransientTtsError 注释）。
 * "能连上"是概率事件，所以**必须有重试**，不能靠一次成功就认定链路可用。
 *
 * 🔴 **迁移到 v2 端点（2026-10-12）**：见下方 `TTS_UPSTREAM_*` 一段的完整说明。
 * 一句话版：旧 host 自 2026-10-10 起全球分批退役（握手恒 403），必须换
 * `api.msedgeservices.com` + `Ocp-Apim-Subscription-Key` + 显式 `speech.config` 帧。
 * 同时**不再依赖 `node-edge-tts` 建连接**（它把旧 host 写死在包内），改由本文件自建 wss。
 */
import { createHash, randomBytes } from 'node:crypto'
import type { ClientRequest, IncomingMessage } from 'node:http'
import WebSocket from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'

export interface TtsOptions {
  /** 音色（默认晓晓；英文内容建议 en-US-AriaNeural） */
  voice?: string
  /** 语速：'default' | '+10%' | '-10%' 等 */
  rate?: string
}

/** 单次合成上限（超出让前端分句，避免一次 WS 合成过长导致超时） */
export const TTS_MAX_CHARS = 2000

// （2026-10-12 移除 `ATTEMPT_TIMEOUT_MS`：整包路径改为复用 `streamOnce` 的两段式超时，
//   详见 `synthesizeOnce` 注释。原来那个 12s 的"整个合成"超时会让长文本更容易被误杀。）
/** 最大尝试次数（1 次原始 + 2 次重试）；与 TTS_RETRY_BACKOFF_MS 长度强耦合 */
export const TTS_MAX_ATTEMPTS = 3
/** 每次重试前的退避（ms），长度必须 = TTS_MAX_ATTEMPTS - 1 */
export const TTS_RETRY_BACKOFF_MS = [400, 1200] as const

// ===== 流式合成（2026-09-28「边收边播」）=====
//
// 为什么值得单开一条路：上游**本来就是流式回块**的（见 `streamOnce` 注释），
// 是 `synthesizeSpeech` 把它攒成了整包（`ttsPromise` 写文件 → 读回 Buffer → `ctx.body = buf`
// → 前端 `res.blob()`），导致**首声 = 整包合成时长**。实测（1596 字）：
//
//   | 载荷 | 首块到达 | 完整合成 |
//   |---|---|---|
//   | 15 字 | 358ms | 574ms |
//   | 1596 字 | 335ms | 18854ms |
//   | 1596 字 | 472ms | 3165ms |
//   | 1596 字 | 602ms | 2584ms |
//
// ⇒ **首块到达与文本长度无关**（恒定 335~602ms），而完整合成差 1~2 个数量级；
//   连"上游最慢那次（18.9s）"的首块也只有 335ms ⇒ 边收边播**对上游抖动免疫**。

/**
 * 首块超时（ms）—— **只约束"握手"与"握手后首块到达"这两个阶段，各自独立计时**。
 *
 * 这是流式相对整包最大的语义改善：原来 `ATTEMPT_TIMEOUT_MS = 12000` 是**整个合成**的超时，
 * 于是"文本越长越容易被误杀"（1596 字常态 2.6~3.9s 已经在边缘）。首块恒定、与文本长度无关，
 * 且**再长的文本也不会因为"合成久"而超时**。
 *
 * ⚠️ 余量要按**两个阶段各自**看，别把两次测量混在一起：
 *   | 阶段 | 实测 | 3s 的余量 |
 *   |---|---|---|
 *   | 裸握手（首次连接建立） | 692~1940ms（2026-09-28 18:1x，8 次） | 1.5×（薄） |
 *   | 握手**之后**到首块 | ~250~600ms | ~5× |
 * 握手阶段余量偏薄是刻意的：中间盒"挂住"（既不 RST 也不回包）时，早一点判死才能早点重试。
 * 代价是**这类超时文案必须被 `isTransientTtsError` 认成瞬时错误**，否则一次都不重试 ——
 * 2026-09-28 17:5x 的真机现象正是这个：连续 4 次请求全部 3s 准时 502，朗读条跳一下
 * 就变成"正在用系统音色"。
 */
export const TTS_FIRST_CHUNK_TIMEOUT_MS = 3000

/** 首块之后的数据中断超时（ms）。上游正常每 ~6ms 回一块，30s 纯粹是防"挂死不报错" */
export const TTS_STREAM_STALL_TIMEOUT_MS = 30000

/** 首块聚合阈值（字节）：4KB ≈ 0.33s 音频 —— 够 `<audio>` 起播，又不必再等 */
export const TTS_STREAM_FIRST_FLUSH_BYTES = 4096
/** 后续块聚合阈值（字节）：上游粒度只有 1570B/块（1596 字 = 2897 块），合并到 16KB 再写 */
export const TTS_STREAM_FLUSH_BYTES = 16384

/**
 * 我们真正用到的上游 socket 成员。
 *
 * 为什么不用 `import('ws').WebSocket` 直接当类型：`ws` 的 `on()` 是**重载**过的，
 * 而我们只依赖这 5 个成员。把它收窄成一份显式契约有两个好处：
 *   · 单测的假 socket 只需实现这 5 个方法（形状一变就红，而不是静默漂移）
 *   · 换连接实现（如 2026-10-12 迁 v2）只波及 `openUpstream` 一处，不扩散到消费方
 */
interface UpstreamSocket {
  on(event: string, listener: (...args: any[]) => void): unknown
  send(data: string): void
  close(): void
  pause(): void
  resume(): void
}

// ===== 上游端点（2026-10-12 迁移到 v2）=====
//
// 🔴 背景：微软自 **2026-10-10** 起把 Edge Read Aloud 从 v1 迁到 v2，旧端点
// `speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` 正在**全球分批退役**
// （欧洲 → 英国 → 美国，逐日推进），症状是 **wss 握手恒返回 403**。
// ⚠️ 排查时最容易被误导的一点：**同一 IP 上 HTTPS 的 `voices/list` 仍然 200** ——
// 于是"域名可达、token 有效、不是 IP 被封"全都成立，偏偏合成不通。
// 上游 `edge-tts` 的 issue #490 记录了全过程（本机复现 + 多国确认）。
//
// 迁移后**唯一可行**的参数组合（社区多国实测 + 本机逐条复验）：
//   · host/path 换新：`api.msedgeservices.com/tts/cognitiveservices/websocket/v1`
//     （⚠️ 路径必须是 `/websocket/v1`；沿用 `/edge/v1` 会 404）
//   · token 参数名换新：`Ocp-Apim-Subscription-Key`（**取值不变**）
//   · `Sec-MS-GEC-Version` **必须保留 legacy `1-143.0.3650.75`** ——
//     谎报 v2 的版本号（`2-155.x`）却没带 v2 token 反而会被 403（issue #490 评论 #18 实测）
//   · **必须显式发 `speech.config` 帧声明 `outputFormat`** —— 不发会用隐式默认值
//     `audio-16khz-32kbitrate-mono-mp3`，被服务端以 `code=1007` 直接关连接
const TTS_UPSTREAM_HOST = 'api.msedgeservices.com'
const TTS_UPSTREAM_PATH = '/tts/cognitiveservices/websocket/v1'
/** 与上游一致的"公开"客户端令牌；在 v2 里它作为 `Ocp-Apim-Subscription-Key` 传递 */
const TTS_UPSTREAM_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
/** 固定 legacy 版本号：见上面的说明，**不要"顺手升级它"** */
const TTS_GEC_VERSION = '1-143.0.3650.75'
/** Edge 客户端 origin（上游握手要求，去掉也能连但保持与上游一致最省事） */
const TTS_UPSTREAM_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'

/**
 * 1601-01-01 → 1970-01-01 的秒差 = **11,644,473,600**（≈369 年）。
 *
 * 🔴 2026-10-12 曾把它写成 `1_164_447_360`（少一位数，恰好是十分之一）⇒ ticks 变成 2.96e16
 * 而非 1.34e17 ⇒ 服务端算不出同一个签名 ⇒ **稳定 403**，且因为 403 只在握手上体现、
 * 与"出口/区域策略"的症状完全同形，白白排查了三轮。**这类常量必须推导、不能手打**：
 *   `Math.round((Date.UTC(1970,0,1) - Date.UTC(1601,0,1)) / 1000)`
 * 单测里也留了一条从日期推导的断言，防止实现与测试"抄同一个错字面量"。
 */
const WIN_EPOCH_OFFSET_S = 11_644_473_600
const TICKS_PER_SECOND = 10_000_000 // FILETIME 是 100ns 粒度
const GEC_WINDOW_TICKS = 300 * TICKS_PER_SECOND // 签名按 5 分钟窗口对齐

/**
 * `Sec-MS-GEC` 签名（等价于上游 `drm.py` 的 `generate_sec_ms_gec()`）。
 *
 * 算法：Unix 秒 + FILETIME 纪元差 → 转 100ns ticks → **对齐到 5 分钟窗口** →
 * 拼客户端令牌做 SHA-256、输出大写十六进制。
 *
 * ⚠️ 必须用 `BigInt`：ticks 量级约 **1.34e17**，而 `Number.MAX_SAFE_INTEGER` 只有 9.0e15 ——
 * 用普通 number 乘出来会静默丢精度，得到一个"看起来合法但服务端算不出同一个值"的签名，
 * 症状就是莫名其妙的 403 且完全无从溯源。
 *
 * 🔴 **这个函数的唯一验收标准是"和上游算出同一串"**，不是"看起来像哈希"。
 * 2026-10-12 我漏了一位纪元常量（见 `WIN_EPOCH_OFFSET_S`），签名格式完全合法、
 * 纯函数与窗口对齐测试全绿，但服务端恒定 403 —— 因为**唯一有效的度量是双向比对**。
 * 复验命令（须在真实网络下）：
 *   `secMsGec(Date.now()) === require('node-edge-tts/dist/drm.js').generateSecMsGecToken()`
 *
 * 为什么自己实现而不是从 `node-edge-tts` 取：我们要连的是新 host，已不再用那个包的 socket，
 * 只为这一个哈希把它留在链路上不划算（且它只导出内部路径 `dist/drm.js`）。
 * 但**它仍是这个函数唯一的对照物**，改动前后都要拿它比一次。
 */
export function secMsGec(nowMs: number = Date.now()): string {
  let ticks = BigInt(Math.floor(nowMs / 1000) + WIN_EPOCH_OFFSET_S) * BigInt(TICKS_PER_SECOND)
  ticks -= ticks % BigInt(GEC_WINDOW_TICKS)
  return createHash('sha256').update(`${ticks}${TTS_UPSTREAM_TOKEN}`, 'ascii').digest('hex').toUpperCase()
}

/** 拼 v2 的 wss URL（每次连接都要新的 `ConnectionId` + 当前窗口的 GEC） */
function buildUpstreamUrl(connectionId: string): string {
  return (
    `wss://${TTS_UPSTREAM_HOST}${TTS_UPSTREAM_PATH}` +
    `?Ocp-Apim-Subscription-Key=${TTS_UPSTREAM_TOKEN}` +
    `&ConnectionId=${connectionId}` +
    `&Sec-MS-GEC=${secMsGec()}` +
    `&Sec-MS-GEC-Version=${TTS_GEC_VERSION}`
  )
}

const UTC_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const UTC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * 上游 `X-Timestamp` 的格式。
 *
 * 刻意**不用** `toUTCString()`：上游要的是 C 风格 `%a %b %d %Y %H:%M:%S GMT+0000 (...)`，
 * 而 `Date.prototype.toUTCString()` 给的是 `Mon, 12 Oct 2026 09:35:44 GMT`（多个逗号、缺后缀）。
 * 帧里那枚结尾的 `Z` 是照抄上游的（它自己标注为"不是笔误，是 Edge 的 bug"）。
 */
function edgeTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${UTC_DAYS[d.getUTCDay()]} ${UTC_MONTHS[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  )
}

/**
 * `speech.config` 帧 —— **必须发在 SSML 之前**。
 *
 * 不发的话服务端套用隐式默认格式 `audio-16khz-32kbitrate-mono-mp3`，然后以
 * `code=1007 Unsupported Edge output format` 直接关闭连接（2026-10-12 实测）。
 * 旧 host 对这个默认值宽容，所以这条约束在迁移前根本不存在 —— 属于"换了 host 才暴露的隐性契约"。
 */
function speechConfigFrame(requestId: string, outputFormat: string): string {
  return (
    `X-RequestId:${requestId}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
            outputFormat,
          },
        },
      },
    })
  )
}

const XML_ESCAPE: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }
function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => XML_ESCAPE[c])
}

/**
 * 合成请求帧。**必须与上游协议逐字一致**。
 *
 * `X-Timestamp` 是协议字段（格式见 `edgeTimestamp`）；`X-RequestId` 由调用方传入，
 * 与 `speech.config` 帧共用同一个 `ConnectionId`，服务端回帧里会带上它。
 */
function ssmlFrame(requestId: string, text: string, voice: string, lang: string, rate: string): string {
  return (
    `X-RequestId:${requestId}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${edgeTimestamp()}Z\r\n` +
    `Path:ssml\r\n\r\n` +
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">` +
    `<voice name="${voice}"><prosody rate="${rate}" pitch="default" volume="default">${escapeXml(text)}</prosody></voice></speak>`
  )
}

/**
 * 建立到上游的 wss 连接（含握手超时）。
 *
 * 为什么不再用 `node-edge-tts` 的 `_connectWebSocket()`：它把**旧 host 写死在包内**，
 * 而旧 host 自 2026-10-10 起全球分批退役（见文件头 `TTS_UPSTREAM_*` 说明）。要连新 host
 * 就只能自己建连接 —— 反正协议帧本来就是我们自己发的，把连接也收回来反而少一层黑盒。
 *
 * ⚠️ 两个必须自己接住的事件：
 *   · `unexpected-response` —— **握手被拒（403/404）在 `ws` 里不触发 `error`**，
 *     不监听就会一路挂到我们自己超时，把"快速失败"伪装成"网络慢"
 *   · `open` 之前的 `error` —— TLS/DNS 层失败走这里
 */
async function openUpstream(connectionId: string): Promise<UpstreamSocket> {
  const proxy = ttsProxyFromEnv()
  const ws = new WebSocket(buildUpstreamUrl(connectionId), {
    origin: TTS_UPSTREAM_ORIGIN,
    headers: { Pragma: 'no-cache', 'Cache-Control': 'no-cache' },
    // 未设 TTS_PROXY 时为 undefined ⇒ 真直连（不自动采用宿主 HTTP_PROXY，见 ttsProxyFromEnv 注释）
    agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
  })

  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null
    let settled = false
    function finish(e?: Error) {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      ws.off('open', onOpen)
      ws.off('error', onError)
      ws.off('unexpected-response', onUnexpected)
      if (e) reject(e); else resolve()
    }
    function onOpen() { finish() }
    function onError(err: unknown) { finish(err instanceof Error ? err : new Error(String(err))) }
    function onUnexpected(_req: ClientRequest, res: IncomingMessage) {
      finish(new Error(`上游握手失败 HTTP ${res.statusCode ?? '?'}`))
    }
    timer = setTimeout(() => finish(new Error('连接上游超时')), TTS_FIRST_CHUNK_TIMEOUT_MS)
    ws.on('open', onOpen)
    ws.on('error', onError)
    ws.on('unexpected-response', onUnexpected)
  })

  return ws as unknown as UpstreamSocket
}

/**
 * 每块消费方。**返回 Promise 即表示"我现在吃不下了"** —— `streamOnce` 会 pause 上游 socket，
 * 等这个 Promise resolve 再 resume。不接反压的话：上游 1596 字只要 2.6~3.9s 吐完
 * （≈1.7MB/s），而 `<audio>` 按 12KB/s 消费 ⇒ 整段音频会先在 Node 内存里堆完，
 * "边收边播"就退化成了"边收边堆"。**这条是流式方案能不能省内存的关键**。
 */
export type TtsChunkSink = (buf: Buffer) => void | Promise<void>

/** 一次流式尝试：连上 → 发帧 → 逐块回调。失败即抛，**不做任何重试** */
async function streamOnce(
  text: string,
  opts: TtsOptions,
  onChunk: TtsChunkSink,
): Promise<void> {
  const voice = opts.voice || DEFAULT_VOICE
  const lang = voice.startsWith('zh') ? 'zh-CN' : 'en-US'
  const rate = opts.rate || 'default'
  // 一次连接一个 ConnectionId：它同时充当 speech.config / ssml 两帧的 X-RequestId，
  // 与服务端回帧里的 X-RequestId 对得上，排查时能把一次合成串成一条线。
  const connectionId = randomBytes(16).toString('hex')

  let sock: UpstreamSocket | null = null
  try {
    // 握手本身也要有超时：403/404 是快速失败，但中间盒也可能让它**挂住**
    sock = await openUpstream(connectionId)
    const socket = sock

    await new Promise<void>((resolve, reject) => {
      let pending = Buffer.alloc(0)
      let flushedFirst = false
      let settled = false
      let timer: NodeJS.Timeout | null = null

      const clear = () => { if (timer) { clearTimeout(timer); timer = null } }
      const finish = (e?: Error) => {
        if (settled) return
        settled = true
        clear()
        if (e) reject(e); else resolve()
      }
      /** 每个阶段都有超时：首块之前是"首块超时"，之后换成"数据中断" */
      const arm = (ms: number, message: string) => {
        clear()
        timer = setTimeout(() => finish(new Error(message)), ms)
      }
      /** 攒够阈值才回调 —— 上游 1570B/块太碎，逐块回调会把 2897 次 write 全抖出去 */
      const push = () => {
        if (!pending.length) return
        const threshold = flushedFirst ? TTS_STREAM_FLUSH_BYTES : TTS_STREAM_FIRST_FLUSH_BYTES
        if (pending.length < threshold) return
        const out = pending
        pending = Buffer.alloc(0)
        flushedFirst = true
        let r: void | Promise<void>
        try {
          r = onChunk(out)
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)))
          return
        }
        if (r && typeof (r as Promise<void>).then === 'function') {
          // 反压：暂停读上游的 socket，消费方 drain 之后再放行
          try { socket.pause() } catch { /* 已经关了 */ }
          ;(r as Promise<void>).then(
            () => { if (!settled) { try { socket.resume() } catch { /* 已经关了 */ } } },
            (e) => finish(e instanceof Error ? e : new Error(String(e))),
          )
        }
      }

      arm(TTS_FIRST_CHUNK_TIMEOUT_MS, '首块超时')

      socket.on('message', (data: any, isBinary: boolean) => {
        // turn.end 之后上游可能还有在途帧；finish 已发生就不再回调，否则会在响应结束后写
        if (settled) return
        if (isBinary) {
          const sep = 'Path:audio\r\n'
          const at = data.indexOf(sep)
          // 正常帧一定带这个头（上游包源码就是 `data.subarray(indexOf(sep) + sep.length)`），
          // 但**找不到时必须整帧当音频**：`indexOf` 返回 -1，`-1 + 12 = 11` 会静默吃掉前 11 字节
          // —— 不报错、只是音频开头缺一小截，是最难查的那类 bug。
          pending = Buffer.concat([pending, at >= 0 ? data.subarray(at + sep.length) : data])
          // 收到数据 = 首块已到 ⇒ 超时语义从"等首块"切到"等下一块"
          arm(TTS_STREAM_STALL_TIMEOUT_MS, '上游数据中断')
          push()
          return
        }
        if (data.toString().includes('Path:turn.end')) {
          if (pending.length) {
            try { onChunk(pending) } catch (e) {
              finish(e instanceof Error ? e : new Error(String(e)))
              return
            }
            pending = Buffer.alloc(0)
          }
          finish()
        }
      })
      socket.on('error', (e: any) => finish(e instanceof Error ? e : new Error(String(e))))
      // 带着 close code/reason 上报：换 v2 之后最典型的失败长这样 ——
      // `code=1007 Unsupported Edge output format: ...`。只报"提前关闭"等于把唯一线索丢掉。
      socket.on('close', (code?: number, reason?: Buffer) => {
        const detail = reason && reason.length ? `${code} ${reason.toString()}` : String(code ?? '?')
        finish(new Error(`上游提前关闭连接（code=${detail}）`))
      })

      // ⚠️ speech.config 必须在 SSML 之前 —— 漏了它服务端会用隐式默认格式并以 code=1007 关连接
      socket.send(speechConfigFrame(connectionId, TTS_OUTPUT_FORMAT))
      socket.send(ssmlFrame(connectionId, text, voice, lang, rate))
    })
  } finally {
    try { sock?.close() } catch { /* 已经关了 */ }
  }
}

/**
 * 流式合成语音。每个音频块回调一次 `onChunk`，**不写任何临时文件**。
 *
 * 重试边界（这是本函数最容易写错、也最值钱的地方）：
 *   · **首块之前**失败 → 走与 `synthesizeSpeech` 同一套退避重试（仍是 TTS_MAX_ATTEMPTS 次）
 *   · **已经回调过块之后**失败 → **一律不重试**。因为那些字节已经写进 HTTP 响应了，
 *     重试只会把同一段音频再吐一遍变成"叠音"，或者写出两套响应头。
 *   · 入参类错误（文本为空/过长）不重试（重试只是把同一个错误拖慢三倍）。
 *
 * 为什么"首块之前"正好覆盖了唯一值得重试的阶段：我们观测到的失败全是**握手被 RST**，
 * 那必然发生在首块之前。
 */
export async function synthesizeSpeechStream(
  text: string,
  opts: TtsOptions,
  onChunk: TtsChunkSink,
): Promise<void> {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('文本为空')
  if (clean.length > TTS_MAX_CHARS) throw new Error(`文本过长（${clean.length} 字 > ${TTS_MAX_CHARS}），请分句请求`)

  let lastErr: Error = new Error('语音合成失败')
  for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt++) {
    let emitted = false
    try {
      // ⚠️ 这一层的 `return` 不能省：漏了它，消费方（路由）为了反压而返回的 Promise
      // 会被悄悄丢掉 ⇒ 上游全速把整段音频灌进内存，"边收边播"退化回"边收边堆"，
      // 而且**没有任何报错**。（单测里的反压用例就是为了钉这个而存在的。）
      await streamOnce(clean, opts, (buf) => { emitted = true; return onChunk(buf) })
      return
    } catch (e: any) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      // 已经吐过字节 ⇒ 响应侧不可能回滚，重试只会产生重复音频
      if (emitted) throw lastErr
      const canRetry = attempt < TTS_MAX_ATTEMPTS && isTransientTtsError(lastErr.message)
      if (!canRetry) throw lastErr
      await delay(TTS_RETRY_BACKOFF_MS[attempt - 1] ?? 1200)
    }
  }
  throw lastErr
}


const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural'

/**
 * 输出音频格式。
 *
 * 2026-09-28 由 `audio-24khz-48kbitrate-mono-mp3` 提到 **96kbps**：
 * 48kbps 的 MP3 对语音偏"闷"（齿音糊、呼吸感丢失），是"听感不够真人"的叠加因素之一。
 * 代价是每句体积 2×（实测同一句话 63360 B → 126720 B），本地播放无所谓。
 *
 * 为什么仍然用 mp3、而不是体积更省的 Opus(webm)：mp3 是 `<audio>` 与所有浏览器
 * （含 PWA 在 Safari 上）的公共子集，Opus-in-WebM 在 Safari 上支持面不稳 ——
 * 播放器稳定性优先于那点体积。想再提质量就调这个常量，别引入新容器格式。
 * （这条由 tts.test.ts 的不变量钉住：改动容器格式会让 PWA 在 Safari 上直接没声音。）
 */
export const TTS_OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3'

/**
 * 这个错误值不值得重试。
 *
 * 2026-09-28 实测：v1 host（`speech.platform.bing.com`）的握手在本机网络约 **3/4 次数**被
 * 中间盒 RST（`read ECONNRESET`，约 0.19s 快速失败），而同一时刻 `www.bing.com` 5/5 可达。
 *
 * 🔴 **2026-10-12 更正这里当时的结论**：上面那段观测被判定为"瞬时抖动、重试能救回大部分"，
 * 是**错的**。真因是微软把 Edge Read Aloud 从 v1 迁到 v2、v1 host **分批退役**（响应头里
 * `Ref` 的区域一路从欧洲→英国→美国推）——**重试救不回"整台 host 退役"**，只有换端点能救。
 * 那次误判的代价是两轮排查方向全错（先怀疑出口、再怀疑握手头），见文件头 v1→v2 说明。
 *
 * 但**这段重试逻辑本身仍然必要**，别因为它曾背错因果就删掉：换到 v2 后握手仍会偶发
 * RST / 超时（迁移后实测过），只是它不再承担"救活整条链路"的角色，而是兜住真正的瞬时故障。
 *
 * ⚠️ **同一件事有多个措辞**（2026-09-28 由 `verify-tts-proxy.mjs` 的闭环验收抓到）：
 * 走代理时同一个 RST 报的是
 * `Client network socket disconnected before secure TLS connection was established`
 * —— 里面**没有** `ECONNRESET` 字样，早先的清单匹配不到 ⇒ **一次都不重试**，
 * 直接以 175ms 快速失败让整轮朗读回落系统音色。所以这里按"**症状**"而不是按错误码来匹配。
 *
 * 反面：入参类错误（文本为空/过长）重试只是把同一个错误拖慢三倍 ⇒ 一律不重试。
 */
export function isTransientTtsError(msg: string): boolean {
  const m = String(msg || '')
  if (/文本为空|文本过长/.test(m)) return false
  // ⚠️ 三个中文症状（`连接上游超时` / `首块超时` / `上游数据中断`）是**我们自己的**超时文案，
  //    2026-09-28 实测漏掉它们的后果：上游"挂住"（不像 RST 那样快速失败）时三条全被判成
  //    不可重试 ⇒ **一次都不重试**、3s 内直接 502 ⇒ 真机上表现为"点朗读，朗读条跳一下
  //    就变成用系统音色"。教训同上面那条：清单按**症状**列，我们加的每种措辞都要进来。
  if (/连接上游超时|首块超时|上游数据中断/.test(m)) return true
  return /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|Client network socket disconnected|socket disconnected|secure TLS connection|Timed out|timed out|timeout|fetch failed|UND_ERR/i
    .test(m)
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 可选音色白名单（前端设置项展示用；都验证过是中文/英文常用神经音色）。
 *
 * `sample` = 该音色的**试听台词**（设置页选中即自动播放）。写成后端字段而不是前端硬编码，
 * 是为了"音色清单 + 自我介绍"只有一份来源 —— 加音色时不可能漏写台词。
 * 中文音色故意混入英文品牌名（"中英文读"），顺带验证中英混排的合成质量。
 */
export const TTS_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女声·自然）', sample: '您好，我是晓晓，是你的 SUPERCRZY BOT.' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女声·活泼）', sample: '您好，我是晓伊，是你的 SUPERCRZY BOT.' },
  { id: 'zh-CN-YunxiNeural', label: '云希（男声·年轻）', sample: '您好，我是云希，是你的 SUPERCRZY BOT.' },
  { id: 'zh-CN-YunyangNeural', label: '云扬（男声·播报）', sample: '您好，我是云扬，是你的 SUPERCRZY BOT.' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（东北话）', sample: '您好，我是晓北，是你的 SUPERCRZY BOT.' },
  { id: 'en-US-AriaNeural', label: 'Aria（English）', sample: "Hi, I'm Aria, your SUPERCRZY BOT." },
] as const

export function defaultVoice(): string {
  return DEFAULT_VOICE
}

/**
 * 可选出口代理，取自环境变量 `TTS_PROXY`（形如 `http://127.0.0.1:7890`）。
 *
 * 历史：2026-09-28 加它，是因为当时旧 host 的 wss 握手在本机网络约 **3/4 次数**被中间盒 RST，
 * 退避重试只能把成功率从 ~25% 抬到 ~75%，且每次失败要付 1.5~12s ⇒ 观感是"点了朗读要干等"。
 * 换一条能通的出口是当时唯一能把成功率拉满的做法。
 *
 * ⚠️ 2026-10-12 的教训（**别再用它去救 403**）：旧 host 全球退役那次，换出口（深圳 / 香港）
 * 完全没有用 —— 因为根因是**上游端点迁移**，不是网络路径。**403 先怀疑端点，别先怀疑出口。**
 * 保留本字段是因为它对"真的连不上"仍然有效，而不是为了绕服务端策略。
 *
 * ⚠️ 两个刻意的设计：
 *   ① **默认不设 = 直连**：`openUpstream` 只在显式设了 `TTS_PROXY` 时才建代理 agent，
 *      所以"不设"就是真的不走代理，不会悄悄改变既有链路。
 *   ② **不自动采用宿主 `HTTP_PROXY`/`HTTPS_PROXY`**：那个宿主代理实测对上游无效，
 *      自动采用只会让链路更难诊断；要绕出口必须显式设 `TTS_PROXY`。
 *
 * 验收：`scripts/diag/verify-tts-proxy.mjs` —— 起一个本地 CONNECT 代理，断言流量**真的**
 * 从代理出去（不是"我把参数传下去了"）。
 */
/**
 * 允许的代理协议 —— **只接受 `http:` / `https:`（HTTP CONNECT 代理）**。
 *
 * 为什么必须挡掉 `socks5://`：`https-proxy-agent` 只对 `https:` 区分"要不要先 TLS 到代理"，
 * **其余协议一律当 HTTP CONNECT 用**（协议部分被直接忽略）。
 * 后果不是报错，而是**把 `CONNECT host:443 HTTP/1.1` 发给一个 SOCKS 端口**，
 * 表现为握手挂住 → 我们重试 3 次白等十几秒。与其让人对着"配了代理反而更慢"排查，
 * 不如在这里挡掉并明确说清原因。
 */
const PROXY_SCHEME_RE = /^https?:\/\//i
let warnedBadProxy = false

export function ttsProxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = String(env.TTS_PROXY || '').trim()
  if (!raw) return undefined
  if (!PROXY_SCHEME_RE.test(raw)) {
    if (!warnedBadProxy) {
      warnedBadProxy = true
      console.warn(
        `[tts] 忽略 TTS_PROXY="${raw}"：只支持 HTTP CONNECT 代理（http:// 或 https://），` +
          `SOCKS5 不在 https-proxy-agent 的支持范围内。本次朗读走直连。`
      )
    }
    return undefined
  }
  return raw
}

/**
 * 一次合成尝试（失败即抛，不做任何重试）。
 *
 * 2026-10-12 起**改为基于 `streamOnce` 实现**：上游只有一个协议，两条入口（整包 / 流式）
 * 各维护一套连接与帧构造是纯粹的重复 —— 迁移 v2 时正是这种重复把"改一处"变成"漏一处"的风险。
 * 顺带消掉旧实现"写临时文件 → 读回 Buffer → 删文件"的整套动作（`tmpdir` 里不再留
 * `supercrzy-tts-*.mp3`），代价是超时语义换成流式的两段式（对长文本反而更宽容）。
 */
async function synthesizeOnce(text: string, opts: TtsOptions): Promise<Buffer> {
  const parts: Buffer[] = []
  await streamOnce(text, opts, (buf) => { parts.push(buf) })
  if (!parts.length) throw new Error('合成结果为空')
  return Buffer.concat(parts)
}

/**
 * 合成语音，返回 mp3 Buffer。失败抛 Error（含原因，路由据此回 400/500）。
 *
 * 带退避重试：只对 `isTransientTtsError` 认定的瞬时网络故障重试，**最多 TTS_MAX_ATTEMPTS 次**。
 * 为什么必须重试：上游握手成功率实测仅 ~25%，而"单次失败即失败"的下游后果是
 * 前端整轮朗读回落系统 TTS（听感机械）+ 设置页试听直接报"服务不可用"。
 */
export async function synthesizeSpeech(text: string, opts: TtsOptions = {}): Promise<Buffer> {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('文本为空')
  if (clean.length > TTS_MAX_CHARS) throw new Error(`文本过长（${clean.length} 字 > ${TTS_MAX_CHARS}），请分句请求`)

  let lastErr: Error = new Error('语音合成失败')
  for (let attempt = 1; attempt <= TTS_MAX_ATTEMPTS; attempt++) {
    try {
      return await synthesizeOnce(clean, opts)
    } catch (e: any) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      const canRetry = attempt < TTS_MAX_ATTEMPTS && isTransientTtsError(lastErr.message)
      if (!canRetry) throw lastErr
      await delay(TTS_RETRY_BACKOFF_MS[attempt - 1] ?? 1200)
    }
  }
  throw lastErr
}
