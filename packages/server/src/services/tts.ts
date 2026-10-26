/**
 * Edge TTS 语音合成服务（2026-09-27）。
 *
 * 为什么用它：Web Speech API（系统 TTS）是拼接式音色，机械感强；Edge TTS 是微软神经网络
 * 音色（zh-CN-XiaoxiaoNeural 等），接近真人。
 *
 * ⚠️ **更正（2026-09-28）**：早先本注释写"中国大陆直连可达（~0.5s 握手）"是**错的** ——
 * 实测该主机的 wss 握手在本机网络约 **3/4 次数**被中间盒 RST（详见 isTransientTtsError 注释）。
 * "能连上"是概率事件，所以**必须有重试**，不能靠一次成功就认定链路可用。
 *
 * 🔴 **迁移到 v2 端点（2026-10-12）→ 第二次协议破坏（2026-10-23）**：
 * 见下方 `TTS_UPSTREAM_*` 一段的完整说明。一句话版：微软 12 天内两次改协议 ——
 * 10-12 迁去的 `api.msedgeservices.com` + v1 GEC 组合自 ~10-23 起握手恒返回
 * HTTP 200（不升级成 ws，空 body）；**旧 host `speech.platform.bing.com/.../edge/v1`
 * 复活，但只认 v2 GEC token**（算法见 `tts-gec.ts`，与上游 `edge-tts==7.3.1`
 * 双向比对 6/6 时间戳 bit-exact）。
 * 同时仍不依赖 `node-edge-tts` 建连接（协议帧全部自发自收）。
 */
import { randomBytes } from 'node:crypto'
import type { ClientRequest, IncomingMessage } from 'node:http'
import WebSocket from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'
// 自动选路的共享状态（手工 TTS_PROXY 优先，其次用这里的结果）
import { getChosenRelay } from './tts-route-state'
import { secMsGecV2 } from './tts-gec'

export interface TtsOptions {
  /** 音色（默认晓晓；英文内容建议 en-US-AriaNeural） */
  voice?: string
  /** 语速：'default' | '+10%' | '-10%' 等 */
  rate?: string
  /**
   * 码率档（2026-10-21）：`'96'`（默认，音质好）/ `'48'`（弱网，体积与带宽减半）。
   * 弱网实测：手机热点出口只有 13KB/s，而 96k 音频要 12KB/s ⇒ 48k 才有余量。
   */
  quality?: TtsQuality
}

/** 单次合成上限（超出让前端分句，避免一次 WS 合成过长导致超时） */
export const TTS_MAX_CHARS = 2000

// （2026-10-12 移除 `ATTEMPT_TIMEOUT_MS`：整包路径改为复用 `streamOnce` 的两段式超时，
//   详见 `synthesizeOnce` 注释。原来那个 12s 的"整个合成"超时会让长文本更容易被误杀。）
/** 最大尝试次数（1 次原始 + 2 次重试）；与 TTS_RETRY_BACKOFF_MS 长度强耦合 */
export const TTS_MAX_ATTEMPTS = 3
/**
 * **握手超时**，与首块超时**分开**（2026-10-21）。
 *
 * 🔴 为什么必须拆开：手机实测（HUAWEI M2，同一 wifi）到 `api.msedgeservices.com` 的
 * TLS 握手是 **1.3 / 1.5 / 3.7 / 6.1s**（冷启动那发 6.1s），而 Mac 同一时刻只有 **0.6s**。
 * 旧实现把「握手」和「首块」共用一个 3000ms 常量 ⇒ 手机端**冷连接必挂**，实机症状是
 * `POST /api/tts → 502，10.79s，连接上游超时`（3 次 × 3s + 退避 ≈ 10.6s），前端随即
 * 回落系统音色并进 60s 冷却，连带把「边生成边朗读」也顶掉（冷却期内 beginStream 返回 false）。
 *
 * 取舍：**12s**。手机实测有两个数：暖连接 TLS 1.3~3.7s、**冷启动首连 > 8s**（8s 版本下
 * 第一条请求仍然 502、总耗时 16.52s）。配合 `warmUpTts()` 开机预热，正常路径根本不会
 * 走到这个上限；它是给"冷 + 慢"叠加时的兜底。
 * **首块仍留在 3s** —— 它与文本长度无关（实测恒定 335~602ms），放宽只会让真挂住的多等。
 */
export const TTS_HANDSHAKE_TIMEOUT_MS = 12000
/**
 * 握手超时**单独封顶 2 次**（1 原始 + 1 重试）。
 *
 * 为什么不是 3 次：握手慢是**链路属性**，不是抖动，重试的收益远低于代价 ——
 * 3 × 8s + 退避 ≈ 25.6s，用户只会觉得"点了朗读没反应"。2 次最坏 8 + 0.4 + 8 ≈ 16.4s。
 * 其它瞬时错误（RST / 5xx）仍走 TTS_MAX_ATTEMPTS = 3，因为它们重试的命中率高得多。
 */
export const TTS_HANDSHAKE_MAX_ATTEMPTS = 2

/**
 * 启动预热（2026-10-21）。
 *
 * 🔴 手机实测（HUAWEI M2，同一 wifi，8s 版本）：后端**刚重启后的第一条**朗读请求
 * 即使给到 8s 也仍然 502（`16.52s` = 两次 8s 握手超时），同一进程的第 2、3 条只要
 * **2.46s / 1.88s**。也就是说冷启动成本（musl 下首次 TLS 握手 + 冷 DNS）不该由
 * 用户第一次点朗读来承担。
 *
 * 做法：开机后自己先握一次手，把 DNS 缓存与 TLS 会话票据热起来。
 * fire-and-forget —— 失败静默、不重试、不阻塞启动（预热失败不代表朗读不可用）。
 */
export function warmUpTts(): void {
  const t = setTimeout(() => {
    synthesizeSpeech('语音预热').catch(() => { /* 预热失败无关紧要 */ })
  }, 3000)
  // 别因为这个定时器拖住进程退出
  if (typeof t.unref === 'function') t.unref()
  // 同时补连接进预热池（真正省握手的是它）；两个码率档各一条
  const w = setTimeout(() => {
    prewarmTts(TTS_FORMATS['96'])
    prewarmTts(TTS_FORMATS['48'])
  }, 3500)
  if (typeof w.unref === 'function') w.unref()
}
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
export interface UpstreamSocket {
  on(event: string, listener: (...args: any[]) => void): unknown
  send(data: string): void
  close(): void
  pause(): void
  resume(): void
}

// ===== 上游端点（2026-10-24 第二次迁移：回到旧 host + v2 GEC）=====
//
// 🔴 时间线（两次协议破坏相隔 12 天）：
//   · 2026-10-10  v1 退役：旧 host 握手恒 403 → 迁 `api.msedgeservices.com` +
//     `Ocp-Apim-Subscription-Key` + v1 GEC（当时唯一可行组合，issue #490）。
//   · ~2026-10-23 新 host 也失效：握手恒 HTTP 200（不升级成 ws、空 body）——
//     这是"软失败"，比 403 更隐蔽：`unexpected-response` 拿到的 statusCode 是 200。
//     本机 + VPS 双端复现（/tmp/tts-probe.cjs）；edge-tts issue（pyvideotrans #8421 同步爆发）。
//   · 2026-10-24 修复：**旧 host 复活了，但只认 v2 GEC token**（`edge-tts==7.3.1`
//     在 VPS 实测合成成功，17.5KB mp3）。
//
// 迁移后**唯一可行**的参数组合（逐条对 `edge-tts==7.3.1` 源码 + VPS 实测复验）：
//   · host/path 回旧版：`speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1`
//   · token 参数名回旧版：`TrustedClientToken`（**取值不变**）
//   · `Sec-MS-GEC` 必须是 **v2 token**（格式 `16hex-64hex`，算法见 `tts-gec.ts`）
//   · `Sec-MS-GEC-Version` = `2-143.0.3650.75`（与 v2 token 配套）
//   · **必须带 `Cookie: muid=<32位随机大写hex>;`**（上游 `DRM.headers_with_muid`）
//   · 仍**必须显式发 `speech.config` 帧**（v2 时代的老契约未变，缺省输出格式会被 1007 关连接）
const TTS_UPSTREAM_HOST = 'speech.platform.bing.com'
const TTS_UPSTREAM_PATH = '/consumer/speech/synthesize/readaloud/edge/v1'
/** 与上游一致的"公开"客户端令牌；旧 host 下参数名是 `TrustedClientToken` */
const TTS_UPSTREAM_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
/** v2 配套版本号 —— **不要"顺手升级它"**，必须与 token 算法版本匹配 */
const TTS_GEC_VERSION = '2-143.0.3650.75'
/** 与 Sec-MS-GEC-Version 同源的 Edge 客户端 UA（上游要求带浏览器指纹） */
const TTS_UPSTREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
/** Edge 客户端 origin（上游握手要求，去掉也能连但保持与上游一致最省事） */
const TTS_UPSTREAM_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'

/**
 * `Sec-MS-GEC` 签名 —— 2026-10-24 起指向 **v2 算法**（`tts-gec.ts`）。
 *
 * 🔴 历史（教训保留，防止重蹈）：
 *   · v1 时代（`createHash('sha256')` 一步出 64hex）：2026-10-12 曾把纪元常量
 *     `11_644_473_600` 手打少一位 ⇒ 签名格式完全合法、纯函数测试全绿，但服务端恒 403 ——
 *     **唯一有效的度量是双向比对**，不是"看起来像哈希"。
 *   · 2026-10-23 微软换 v2：自定义 SHA-256 变体 + CS64，任何"内联重写"都不可靠，
 *     故独立成 `tts-gec.ts` 并以下游 Python 实现为唯一对照（6/6 时间戳 bit-exact）。
 *
 * 保留旧签名 `secMsGec(nowMs)` 以免牵动调用面；它现在就是 `secMsGecV2` 的别名。
 */
export function secMsGec(nowMs: number = Date.now()): string {
  return secMsGecV2(Math.floor(nowMs / 1000))
}

/** 拼 wss URL（每次连接都要新的 `ConnectionId` + 当前窗口的 v2 GEC） */
function buildUpstreamUrl(connectionId: string): string {
  return (
    `wss://${TTS_UPSTREAM_HOST}${TTS_UPSTREAM_PATH}` +
    `?TrustedClientToken=${TTS_UPSTREAM_TOKEN}` +
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
export function speechConfigFrame(requestId: string, outputFormat: string): string {
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
export function ssmlFrame(requestId: string, text: string, voice: string, lang: string, rate: string): string {
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
export async function openUpstream(
  connectionId: string,
  /**
   * 显式指定出口：
   *   · `undefined` = 用当前选路结果（`ttsProxyFromEnv()`，含自动选中的中继）
   *   · `null` = **强制直连**（探测直连基线时用）
   *   · `string` = 强制走这个代理（探测各中继时用）
   */
  proxyOverride?: string | null,
): Promise<UpstreamSocket> {
  const proxy = proxyOverride === undefined ? ttsProxyFromEnv() : proxyOverride === null ? undefined : proxyOverride
  // muid：上游 `DRM.generate_muid()` = 16 随机字节的 hex 大写，Cookie 形如 `muid=<MUID>;`
  // （v2 握手必带；缺了会被当作非 Edge 客户端拒绝）。
  const muid = randomBytes(16).toString('hex').toUpperCase()
  const ws = new WebSocket(buildUpstreamUrl(connectionId), {
    origin: TTS_UPSTREAM_ORIGIN,
    headers: {
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      'User-Agent': TTS_UPSTREAM_UA,
      Cookie: `muid=${muid};`,
    },
    // 未设 TTS_PROXY 时为 undefined ⇒ 真直连（不自动采用宿主 HTTP_PROXY，见 ttsProxyFromEnv 注释）
    agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
  })

  // 🔴 永久哑监听器（2026-10-20 事故修复）：`ws` 在握手被拒（429/403）时会走
  // abortHandshake → `req.destroy()` → 随后 `emit('error')`。而 EventEmitter 对 `'error'`
  // 在**没有监听器**时不是静默丢弃，而是**直接 throw** ⇒ 冒成 uncaughtException ⇒ 整个
  // BOT 进程退出（实机现场：连打几次 ticket 撞上游 429，`/api/health` 直接返回 000）。
  // 这里挂一个永不移除的监听器兜底，覆盖两个裸奔窗口：
  //   ① openUpstream 已 settle、listener 被摘掉之后；
  //   ② openUpstream resolve 到 streamOnce 注册监听之间的微任务间隙。
  ws.on('error', () => { /* 兜底吞掉，真正的错误由下面 promise 里的 onError 上报 */ })

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
      // 只摘"有语义"的那三个；上面那个哑监听器必须留着（理由见它在注册处的注释）。
      if (e) reject(e); else resolve()
    }
    function onOpen() { finish() }
    function onError(err: unknown) { finish(err instanceof Error ? err : new Error(String(err))) }
    function onUnexpected(_req: ClientRequest, res: IncomingMessage) {
      finish(new Error(`上游握手失败 HTTP ${res.statusCode ?? '?'}`))
    }
    timer = setTimeout(() => finish(new Error('连接上游超时')), TTS_HANDSHAKE_TIMEOUT_MS)
    ws.on('open', onOpen)
    ws.on('error', onError)
    ws.on('unexpected-response', onUnexpected)
  })

  return ws as unknown as UpstreamSocket
}

/**
 * ===== 连接预热池（2026-10-21）=====
 *
 * 🔴 为什么需要：手机实测同一段 418 字，
 *   · 走 `POST /api/tts`（整包，连接已热）→ **1.9~2.6s**
 *   · 走 `/api/tts/stream`（每段一条新 ws）→ **首字节 7.5 / 9.4 / 10.6s**
 * 差额就是"每段现场握手 + 首个音频块"的固定成本。长回复被切成 N 段就要付 N 次，
 * 用户听到的就是"读一段、停七八秒、再读一段"（卡壳）。
 *
 * 做法：常备**一条已握手完成、已发过 speech.config** 的连接；
 * 有合成请求进来就直接接管，省掉 1.3~10s 的握手。用完立刻在后台补一条，
 * 让"下一段"也能白拿。
 *
 * 三个保守约定（都是踩过坑的）：
 *   ① **TTL 60s**：上游对空闲连接会主动关，超龄的连接不敢用（用了等于白等一次 RST）。
 *   ② **关闭即作废**：挂 `close`/`error` 监听，连接一断就把槽清空，绝不让死连接留在池里。
 *   ③ **预热失败静默**：它只是优化，不能因为预热门失败就让正常朗读报错（也绝不打日志噪音）。
 */
const WARM_TTL_MS = 60_000
/**
 * 槽位按 `outputFormat` 分桶（2026-10-21）。
 *
 * 为什么必须分桶：`speech.config` 一旦发出，这条连接的输出格式就定死了。
 * 只备一条 96k 的池，弱网用户降档到 48k 时**白等一次完整握手**（手机实测 18 秒）——
 * 而弱网用户恰恰是最付不起握手成本的那批人。所以两种档各备一条。
 */
const warmPool = new Map<string, WarmSlot>()
interface WarmSlot {
  sock: UpstreamSocket
  connectionId: string
  openedAt: number
  /** 这条连接上**已经发过**的 speech.config 的 outputFormat —— 码率不同的请求不能复用 */
  format: string
}
let warmInFlight = new Set<string>()
/** 预热连续失败时的退避截止时间（避免上游挂着时被我们反复握手打） */
let warmBackoffUntil = 0

/** 补一条预热连接（幂等：已有槽或在途就直接返回） */
export function prewarmTts(format: string = TTS_OUTPUT_FORMAT): void {
  // 单测里默认关掉：预热会额外建一条连接，把「重试了几次」这类断言的计数打乱。
  // 需要专门验证预热池的用例把 TTS_TEST_PREWARM=1 打开。
  if (process.env.VITEST && process.env.TTS_TEST_PREWARM !== '1') return
  if (warmPool.has(format) || warmInFlight.has(format)) return
  if (Date.now() < warmBackoffUntil) return
  warmInFlight.add(format)
  const job = (async () => {
    const connectionId = randomBytes(16).toString('hex')
    try {
      const sock = await openUpstream(connectionId)
      // speech.config 必须在任何 ssml 之前，预热阶段就先发掉（它不依赖文本）
      sock.send(speechConfigFrame(connectionId, format))
      const slot: WarmSlot = { sock, connectionId, openedAt: Date.now(), format }
      // 连接一断就作废：绝不让死连接留在池里被下一次合成捡到
      sock.on('close', () => { if (warmPool.get(format)?.sock === sock) warmPool.delete(format) })
      sock.on('error', () => { if (warmPool.get(format)?.sock === sock) warmPool.delete(format) })
      warmPool.set(format, slot)
    } catch {
      // 预热失败：退避 30s，别把上游的抖动放大成握手风暴
      warmBackoffUntil = Date.now() + 30_000
    } finally {
      warmInFlight.delete(format)
    }
  })()
  void job
}

/** 清空预热池 —— **仅供单测**（模块级状态，测试之间必须复位，否则用例互相污染） */
export function resetTtsWarmPool(): void {
  for (const w of warmPool.values()) { try { w.sock.close() } catch { /* 已关 */ } }
  warmPool.clear()
  warmInFlight.clear()
  warmBackoffUntil = 0
}

/**
 * 取一条可用连接（超龄直接丢弃）。**导出给会话式朗读复用**（见 services/tts-session.ts）
 *
 * ⚠️ 必须按 `format` 匹配：连接上的 `speech.config` 已经把输出格式定死了，
 * 拿一条 96k 的连接去合成 48k 会得到 96k 的音频（或直接被上游判 1007），
 * 而这种错**不会报错**，只会让人听到"怎么还是那么费流量"。
 */
export function takeWarmConnection(format: string = TTS_OUTPUT_FORMAT): WarmSlot | null {
  const w = warmPool.get(format)
  if (!w) return null
  warmPool.delete(format)
  if (Date.now() - w.openedAt > WARM_TTL_MS) {
    try { w.sock.close() } catch { /* 已关 */ }
    return null
  }
  return w
}

/**
 * 每块消费方。**返回 Promise 即表示"我现在吃不下了"** —— `streamOnce` 会 pause 上游 socket，
 * 等这个 Promise resolve 再 resume。不接反压的话：上游 1596 字只要 2.6~3.9s 吐完
 * （≈1.7MB/s），而 `<audio>` 按 12KB/s 消费 ⇒ 整段音频会先在 Node 内存里堆完，
 * "边收边播"就退化成了"边收边堆"。**这条是流式方案能不能省内存的关键**。
 */
export type TtsChunkSink = (buf: Buffer) => void | Promise<void>

/**
 * 已退役音色（2026-10-24）：旧 host 上对中文文本**静默挂死**（零音频、不回 turn.end，
 * 见 DEFAULT_VOICE 注释的实测矩阵）。设置表里可能还持久化着它们 ——
 * 在 streamOnce 入口统一迁移到默认音色，别让老用户的选择悄悄变成"整轮朗读失败"。
 */
const RETIRED_VOICES = new Set([
  'en-US-AvaMultilingualNeural',
  'en-US-AndrewMultilingualNeural',
  'en-US-JennyMultilingualNeural',
])

/** 退役音色清单（下发给前端做选择迁移：设置里存过的旧值要能识别出来） */
export function retiredVoices(): string[] {
  return [...RETIRED_VOICES]
}

/** 退役音色 → 默认音色（tts-session 的 liveVoice 与 streamOnce 共用这一份清单） */
export function normalizeVoice(voice?: string): string {
  return voice && RETIRED_VOICES.has(voice) ? DEFAULT_VOICE : voice || DEFAULT_VOICE
}

/** 一次流式尝试：连上 → 发帧 → 逐块回调。失败即抛，**不做任何重试** */
async function streamOnce(
  text: string,
  opts: TtsOptions,
  onChunk: TtsChunkSink,
): Promise<void> {
  // Language-aware voice: an unset voice previously fell through to the English default, so every
  // Chinese user was hearing Chinese pronounced by an English voice model (slow, flat tones).
  // A voice the user picked explicitly still wins — see pickVoiceForText.
  const voice = pickVoiceForText(text, opts.voice)
  const lang = voice.startsWith('zh') ? 'zh-CN' : 'en-US'
  const rate = opts.rate || 'default'
  const fmt = formatForQuality(opts.quality) ?? TTS_OUTPUT_FORMAT
  // 一次连接一个 ConnectionId：它同时充当 speech.config / ssml 两帧的 X-RequestId，
  // 与服务端回帧里的 X-RequestId 对得上，排查时能把一次合成串成一条线。
  // （捡预热连接时会被换成那条连接自己的 ConnectionId —— 两帧必须同源，不能混。）
  let connectionId = randomBytes(16).toString('hex')

  let sock: UpstreamSocket | null = null
  /** 这条连接是不是从预热池捡的（捡来的**已经发过 speech.config**，不能再发一遍） */
  let preConfigured = false
  try {
    // 握手本身也要有超时：403/404 是快速失败，但中间盒也可能让它**挂住**
    const w = takeWarmConnection(fmt)
    if (w) {
      sock = w.sock
      connectionId = w.connectionId
      preConfigured = true
    } else {
      sock = await openUpstream(connectionId)
    }
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
      // 捡来的预热连接**已经发过**这一帧，重复发会让服务端把第二条配置当新请求处理。
      if (!preConfigured) socket.send(speechConfigFrame(connectionId, fmt))
      socket.send(ssmlFrame(connectionId, text, voice, lang, rate))
    })
  } finally {
    try { sock?.close() } catch { /* 已经关了 */ }
    // 用完立刻补一条，让"下一段"直接白拿握手 —— 这一步是长回复不再卡壳的关键
    prewarmTts()
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
      const canRetry = attempt < maxAttemptsFor(lastErr.message) && isTransientTtsError(lastErr.message)
      if (!canRetry) throw lastErr
      await delay(TTS_RETRY_BACKOFF_MS[attempt - 1] ?? 1200)
    }
  }
  throw lastErr
}


/**
 * 默认音色（2026-10-16 改 → **2026-10-24 再改**）。
 *
 * 历史：`zh-CN-XiaoxiaoNeural`（晓晓读英文带口音）→ `en-US-AvaMultilingualNeural`
 * （多语言，中英混排自然）→ **`en-US-EmmaMultilingualNeural`**。
 *
 * 🔴 2026-10-24 换掉 Ava 的原因：迁回旧 host（见文件头）后实测，Multilingual 音色
 * 对中文文本**按音色随机静默挂死** —— 连接正常、turn.start/response 正常，
 * 然后**零音频、不回 turn.end**，只能靠 3s 首块超时兜底（重试 3 次全挂 = 整轮朗读失败
 * 回落机械音）。实测矩阵（同句中文）：
 *   AvaMultilingual = 0 ✗   JennyMultilingual = 0 ✗
 *   EmmaMultilingual = 41631 ✓   SeraphinaMultilingual = 40925 ✓
 *   Xiaoxiao(中英) ✓   Yunxi(中英混排) ✓
 * Emma 中英双通（英文 36633 / 中文 41631），故选它。
 *
 * ⚠️ **中文区没有 Multilingual 音色**（上游总表 322 个音色里 `zh-CN-*Multilingual*` = 0），
 * 所以中英通用只能从 `en-US-*-MultilingualNeural` 里选。想纯中文最自然的话，设置里可选回晓晓。
 */
const DEFAULT_VOICE = 'en-US-EmmaMultilingualNeural'

/**
 * 中文专用默认音色（2026-10-26）。
 *
 * 为什么需要它：`DEFAULT_VOICE` 是**英文**音色，用它读中文虽然能出声，但发音器官是按英文
 * 建模的 —— 中文四声被压平、声母韵母过渡不自然，听感是"闷、糊、听不清在读什么"。
 * 客观测量（同一句中文，24kHz/96kbps 两者相同）：
 *
 *   | 音色 | 时长 | 过零率 | RMS |
 *   |---|---|---|---|
 *   | Emma（英文）   | 9.77s | 0.1893 | 2694 |
 *   | 晓晓（中文）   | 8.66s | 0.1359 | 2706 |
 *
 * 即英文音色读中文**慢 12.8%、高频噪感高 39%**，而音量完全相同（RMS 差 0.4%）——
 * 所以这不是"声音小"，是"发音不准"。中文文本必须用中文音色。
 *
 * ⚠️ 采样率无法再提升：上游对 `audio-48khz-*` 一律回 `1007 Unsupported Edge output format`
 * （2026-10-26 实测），24kHz 已是顶格。
 */
export const DEFAULT_VOICE_ZH = 'zh-CN-XiaoxiaoNeural'

/** CJK 统一表意文字（含扩展 A、兼容区）。日文假名/韩文谚文不在此范围，按各自语言处理。 */
const CJK_CHAR_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g

/**
 * 汉字占"有效字符"的比例（忽略空白与标点，避免短句被标点稀释）。无有效字符时返回 0。
 *
 * ⚠️ 它**只回答"汉字占多少"**，不能单独用来判语种 —— 日文正文汉字占比可达 0.45。
 * 判语种请用 `detectTtsLang()`，那里先排假名/谚文。
 */
export function cjkRatio(text: string): number {
  const meaningful = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '')
  if (!meaningful) return 0
  const cjk = meaningful.match(CJK_CHAR_RE)
  return (cjk ? cjk.length : 0) / meaningful.length
}

/**
 * 汉字占比达到这个阈值即视为"中文文本"。取 0.15 而不是 0.5：
 * 中英混排的技术文本（"把这个 API 的返回值打印出来"）汉字占比常在 0.4~0.6，
 * 而纯英文里偶尔夹一个中文词（<0.1）不该触发中文音色。
 */
const CJK_VOICE_THRESHOLD = 0.15
/** 日文假名（平假名 + 片假名）。日文正文里汉字常占多数，靠汉字判语种会把它误判成中文。 */
const KANA_RE = /[\u3040-\u30ff]/
/** 韩文谚文 */
const HANGUL_RE = /[\uac00-\ud7af\u1100-\u11ff]/
/** 西里尔字母（俄/乌/保等） */
const CYRILLIC_RE = /[\u0400-\u04ff]/

/**
 * 文本语种判定（只用于挑音色，不需要精确）。
 *
 * 🔴 2026-10-26：**顺序很关键**。必须先看假名/谚文，再看汉字 —— 日文正文里汉字可达 40%
 * 以上（「日本語のテストです。音声が正しく…」汉字占比 0.45），先判汉字就会把日文当中文，
 * 用中文音色去读假名，比"英文口音"错得更彻底。前端 `detectSpeechLang()` 一直是这个顺序，
 * 服务端此前只有 cjkRatio 一条线，两边不一致 —— 现在对齐。
 */
export function detectTtsLang(text: string): string {
  const s = String(text || '')
  if (KANA_RE.test(s)) return 'ja'
  if (HANGUL_RE.test(s)) return 'ko'
  if (cjkRatio(s) >= CJK_VOICE_THRESHOLD) return 'zh'
  if (CYRILLIC_RE.test(s)) return 'ru'
  return 'en'
}

/**
 * 未指定音色时，语种 → 默认音色。
 *
 * 全部来自 `TTS_VOICES` 里已登记的专用音色（母语级），不再一律落到英文多语言音色。
 * 落不到的语种走 `DEFAULT_VOICE`（Emma 是多语言音色，能读拉丁语系，只是带英文口音 ——
 * 这比"用中文音色读日文"里的那种错法轻得多）。
 */
const VOICE_BY_LANG: Record<string, string> = {
  zh: 'zh-CN-XiaoxiaoNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
  ru: 'ru-RU-SvetlanaNeural',
  fr: 'fr-FR-DeniseNeural',
  es: 'es-ES-ElviraNeural',
  de: 'de-DE-KatjaNeural',
  it: 'it-IT-ElsaNeural',
  pt: 'pt-BR-FranciscaNeural',
  en: 'en-US-EmmaMultilingualNeural',
}

/**
 * 决定这次合成用哪个音色。
 *
 * 优先级：
 *   1. **用户显式指定**（设置页选过音色）→ 一律尊重，即使语言不匹配 —— 那是他的选择
 *   2. 未指定 → **按文本语种自动选**（日/韩/俄有专属字符特征，拉丁语系按常见项判定）
 *
 * 第 2 条 2026-10-26 加。之前未指定时一律落到英文默认音色，中文用户听到"英文音色读中文"；
 * 而同一次修改若只判"是不是中文"，日文会被汉字占比误判成中文，错得更彻底 —— 见 detectTtsLang。
 */
export function pickVoiceForText(text: string, requested?: string): string {
  const asked = String(requested || '').trim()
  if (asked) return normalizeVoice(asked)
  return VOICE_BY_LANG[detectTtsLang(text)] ?? DEFAULT_VOICE
}

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
 * 可选码率档（2026-10-21）。
 *
 * 为什么要分档：96k 是默认（齿音清晰），但**弱网下它就是不可用** ——
 * 实测手机热点出口 13KB/s，而 96k 音频 = 12KB/s，只剩 1KB/s 余量，必然 underrun。
 * 48k 只要 6KB/s，同样的链路就有一倍缓冲。
 *
 * ⚠️ 只列上游**实测支持**的两种 mp3 档（都是无 ID3 头的纯帧流，可拼接）。
 * webm-opus 虽然也存在，但每轮带 EBML 头，拼不成一条流 —— 不能用于会话式朗读。
 */
export const TTS_FORMATS = {
  '96': 'audio-24khz-96kbitrate-mono-mp3',
  '48': 'audio-24khz-48kbitrate-mono-mp3',
} as const

export type TtsQuality = keyof typeof TTS_FORMATS

/** 解析码率档 → 上游 outputFormat；非法值返回 null（调用方据此回 400） */
export function formatForQuality(q: unknown): string | null {
  const k = String(q ?? '').trim()
  return (TTS_FORMATS as Record<string, string>)[k] ?? null
}

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
  // 🔴 握手被拒（2026-10-20 事故）：上游限流时消息是 `上游握手失败 HTTP 429`，
  // 原清单**一个模式都不匹配** ⇒ 一次都不重试 ⇒ 整轮朗读回落系统音色（听感机械）；
  // 更糟的是那次 ws 错误还打死了进程（见 openUpstream 的哑监听器注释）。
  // 但只有 **429 / 5xx** 是瞬时的、值得重试；403（token 失效）/404（路径错）属配置问题，
  // 重试只是把同一结果拖慢 1.6s —— tts.test.ts 明确要求 403 必须 <1s 快速失败。
  if (/上游握手失败/.test(m)) return /HTTP (429|5\d\d)/.test(m)
  return /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|Client network socket disconnected|socket disconnected|secure TLS connection|Timed out|timed out|timeout|fetch failed|UND_ERR/i
    .test(m)
}

/**
 * 这次失败最多允许尝试几次。
 *
 * 只有**握手超时**单独封顶（2 次）：它是链路属性而不是抖动，重试命中率低而代价高。
 * 其它瞬时错误仍用 TTS_MAX_ATTEMPTS —— 它们重试一次救回来的概率很高（RST / 5xx 都是）。
 */
export function maxAttemptsFor(lastErrMsg: string): number {
  return /连接上游超时/.test(String(lastErrMsg || '')) ? TTS_HANDSHAKE_MAX_ATTEMPTS : TTS_MAX_ATTEMPTS
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 可选音色白名单（前端设置项展示用；都验证过是中文/英文常用神经音色）。
 *
 * `sample` = 该音色的**试听台词**（设置页选中即自动播放）。写成后端字段而不是前端硬编码，
 * 是为了"音色清单 + 自我介绍"只有一份来源 —— 加音色时不可能漏写台词。
 * 中文音色故意混入英文品牌名（"中英文读"），顺带验证中英混排的合成质量。
 */
export interface TtsVoice {
  id: string
  /** 中文标签（默认中文界面用） */
  label: string
  /** 英文标签（全球用户） */
  labelEn: string
  /** 试听台词（用该音色自己的语言念，便于一听就知道对不对） */
  sample: string
}

export const TTS_VOICES: readonly TtsVoice[] = [
  // ── 中英通用（Edge TTS 多语言音色）—— 默认档，读英文不带中文口音 ──
  // 🔴 2026-10-24：Ava / Andrew / Jenny 在旧 host 上对中文**静默挂死**（零音频、
  // 不回 turn.end，见 DEFAULT_VOICE 注释的实测矩阵），从白名单剔除。
  { id: 'en-US-EmmaMultilingualNeural', label: 'Emma（中英通用·女声）', labelEn: 'Emma (multilingual, female)', sample: "Hi, I'm Emma. 您好，我是 Emma，是你的 SUPERCRZY BOT." },
  { id: 'en-US-BrianMultilingualNeural', label: 'Brian（中英通用·男声）', labelEn: 'Brian (multilingual, male)', sample: "Hi, I'm Brian. 您好，我是 Brian，是你的 SUPERCRZY BOT." },
  // ── 中文专用（纯中文最自然；读英文会带口音）──
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（中文·女声·自然）', labelEn: 'Xiaoxiao (Chinese, female)', sample: '您好，我是晓晓，是你的 SUPERCRZY BOT.' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（中文·女声·活泼）', labelEn: 'Xiaoyi (Chinese, female)', sample: '您好，我是晓伊，是你的 SUPERCRZY BOT.' },
  { id: 'zh-CN-YunxiNeural', label: '云希（中文·男声·年轻）', labelEn: 'Yunxi (Chinese, male)', sample: '您好，我是云希，是你的 SUPERCRZY BOT.' },
  { id: 'zh-CN-YunyangNeural', label: '云扬（中文·男声·播报）', labelEn: 'Yunyang (Chinese, male)', sample: '您好，我是云扬，是你的 SUPERCRZY BOT.' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（中文·东北话）', labelEn: 'Xiaobei (Chinese, Northeastern)', sample: '您好，我是晓北，是你的 SUPERCRZY BOT.' },
  // ── 其它语言（2026-10-24 全球视野新增，全部**实测出声**后才入册）──
  // 每条都在旧 host + v2 GEC 参数下验证过音频字节数 > 0，见 daily log。
  { id: 'fr-FR-DeniseNeural', label: 'Denise（法语·女声）', labelEn: 'Denise (French, female)', sample: 'Bonjour, je suis Denise, votre SUPERCRZY BOT.' },
  { id: 'es-ES-ElviraNeural', label: 'Elvira（西语·女声）', labelEn: 'Elvira (Spanish, female)', sample: 'Hola, soy Elvira, tu SUPERCRZY BOT.' },
  { id: 'de-DE-KatjaNeural', label: 'Katja（德语·女声）', labelEn: 'Katja (German, female)', sample: 'Hallo, ich bin Katja, dein SUPERCRZY BOT.' },
  { id: 'it-IT-ElsaNeural', label: 'Elsa（意语·女声）', labelEn: 'Elsa (Italian, female)', sample: 'Ciao, sono Elsa, il tuo SUPERCRZY BOT.' },
  { id: 'pt-BR-FranciscaNeural', label: 'Francisca（葡语·女声）', labelEn: 'Francisca (Portuguese, female)', sample: 'Olá, eu sou a Francisca, sua SUPERCRZY BOT.' },
  { id: 'ru-RU-SvetlanaNeural', label: 'Svetlana（俄语·女声）', labelEn: 'Svetlana (Russian, female)', sample: 'Здравствуйте, я Svetlana, ваш SUPERCRZY BOT.' },
  { id: 'ja-JP-NanamiNeural', label: 'Nanami（日语·女声）', labelEn: 'Nanami (Japanese, female)', sample: 'こんにちは、Nanami です。あなたの SUPERCRZY BOT です。' },
  { id: 'ko-KR-SunHiNeural', label: 'SunHi（韩语·女声）', labelEn: 'SunHi (Korean, female)', sample: '안녕하세요, SunHi 입니다. 당신의 SUPERCRZY BOT 입니다.' },
] as const

/** 音色 id → 语言标签（`fr-FR-DeniseNeural` → `fr-FR`；多语言音色 → `en-US`） */
export function voiceLang(id: string): string {
  const parts = String(id || '').split('-')
  return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'en-US'
}

/** 语种 → 默认音色（全球用户不再被塞一个英文音色） */
export function defaultVoiceFor(locale?: string): string {
  const base = String(locale || '').toLowerCase().split(/[-_]/)[0]
  const hit = TTS_VOICES.find((v) => voiceLang(v.id).toLowerCase().startsWith(`${base}-`))
  return hit ? hit.id : DEFAULT_VOICE
}

/**
 * 按请求语言给出可用音色（2026-10-24 全球化）。
 *
 * 规则：**通用音色（Multilingual）恒在 + 该语言的专用音色**；
 * 请求语言没有专用音色时，退回默认档（中英通用），绝不返回空清单。
 * `locale` 的格式任意（`zh-CN` / `en` / `fr-FR` / `pt_BR`），只取主语言码。
 */
export function voicesForLocale(locale?: string): TtsVoice[] {
  const base = String(locale || '').trim().toLowerCase().split(/[-_]/)[0]
  const universal = TTS_VOICES.filter((v) => v.id.includes('Multilingual'))
  const localized = base ? TTS_VOICES.filter((v) => !v.id.includes('Multilingual') && voiceLang(v.id).toLowerCase().startsWith(`${base}-`)) : []
  // zh / en 之外没有专用音色的语种 → 至少给通用档，避免"设置页空白"
  return localized.length ? [...localized, ...universal] : [...universal]
}

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
  if (raw) {
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
    // 手工指定优先级最高：它就是最终答案，不去看自动选路结果
    return raw
  }
  // 没手工指定 → 用自动选路的结果（未探测过时 getChosenRelay 返回 undefined = 直连）
  return getChosenRelay()
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
      const canRetry = attempt < maxAttemptsFor(lastErr.message) && isTransientTtsError(lastErr.message)
      if (!canRetry) throw lastErr
      await delay(TTS_RETRY_BACKOFF_MS[attempt - 1] ?? 1200)
    }
  }
  throw lastErr
}
