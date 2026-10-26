import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  TTS_VOICES,
  voicesForLocale,
  defaultVoiceFor,
  voiceLang,
  TTS_MAX_CHARS,
  TTS_MAX_ATTEMPTS,
  TTS_RETRY_BACKOFF_MS,
  TTS_OUTPUT_FORMAT,
  TTS_FIRST_CHUNK_TIMEOUT_MS,
  TTS_HANDSHAKE_TIMEOUT_MS,
  TTS_HANDSHAKE_MAX_ATTEMPTS,
  maxAttemptsFor,
  TTS_STREAM_FIRST_FLUSH_BYTES,
  TTS_STREAM_FLUSH_BYTES,
  defaultVoice,
  DEFAULT_VOICE_ZH,
  pickVoiceForText,
  cjkRatio,
  detectTtsLang,
  retiredVoices,
  isTransientTtsError,
  secMsGec,
  synthesizeSpeech,
  synthesizeSpeechStream,
  ttsProxyFromEnv,
  prewarmTts,
  resetTtsWarmPool,
  TTS_FORMATS,
  formatForQuality,
} from './tts'
import { HttpsProxyAgent } from 'https-proxy-agent'

/**
 * 把**连接层**（`ws`）换成可控替身。
 *
 * ⚠️ 用 `vi.hoisted` 里的普通状态对象，**不用 `vi.fn()`**：vitest 4 会内省 spy 的调用结果，
 * 把 `mockRejectedValue` / `mockImplementation(async () => { throw })` 产生的 rejected promise
 * 报成 unhandled error，测试失败信息会指向 mock 设置那一行 —— 看起来像业务代码错了，实际不是。
 * 普通对象没有这层内省，行为跟线上一致。
 */
const state = vi.hoisted(() => ({
  // ---- 连接层：假 `ws` ----
  /** 累计建立过几次连接 */
  connectAttempts: 0,
  /** 前 N 次连接以 `error` 失败（模拟网络层瞬时故障） */
  connectFails: 0,
  /** 连接失败时的错误文案 */
  connectFailMessage: 'read ECONNRESET',
  /** 前 N 次连接以 `unexpected-response` 被拒（模拟 403 —— ws 里这条**不走 error**） */
  handshakeRejects: 0,
  /** 最近一次 `new WebSocket(url, opts)` 的 url */
  lastUrl: '',
  /** 最近一次 `new WebSocket(url, opts)` 的 opts（验 proxy → agent 透传用） */
  lastOpts: null as any,
  /** 按发送顺序记录所有帧（验 speech.config 必须先于 ssml） */
  sentFrames: [] as string[],

  // ---- 数据层：假 socket 的回吐行为 ----
  /** 连上之后要回吐的二进制块（每次尝试都重放同一份） */
  chunks: [] as Buffer[],
  /** 每块之间的间隔（ms）。>0 才能观察到反压的 pause/resume */
  chunkIntervalMs: 0,
  /** 首块延迟（ms） */
  firstChunkDelayMs: 0,
  /** 是否在块发完后以 `Path:turn.end` 正常收尾 */
  sendTurnEnd: true,
  /** 是否在块发完后改为抛错（用来验"已吐字节后不重试"） */
  errorAfterChunk: false,
  /** 假 socket 上发生过的 pause/resume 序列 */
  socketEvents: [] as string[],
  /** 二进制帧不带 `Path:audio\r\n` 头（验"找不到分隔符时整帧当音频"的防御分支） */
  rawFrame: false,
}))

/**
 * 假 `ws`。
 *
 * 为什么改成 mock 连接层（原来是 mock `node-edge-tts`）：2026-10-12 迁 v2 后，
 * **连接是我们自己建的**（见 `openUpstream`）—— 上游包已不在链路上。
 * 继续 mock 它就等于测一个不存在的依赖。
 *
 * ⚠️ 关键细节：`open` / `error` / `unexpected-response` 一律用 `setTimeout(…, 0)` 触发，
 * 而不是在构造函数里同步触发 —— 真实的 `ws` 事件永远晚于 `on()` 注册。同步触发会让
 * `openUpstream` 的监听器一个都还没挂上就发完了，测试**全绿但什么都没测到**。
 */
vi.mock('ws', () => {
  class FakeWebSocket {
    private handlers = new Map<string, Array<(...a: any[]) => void>>()

    constructor(url: string, opts: any) {
      state.lastUrl = url
      state.lastOpts = opts
      state.connectAttempts += 1
      const attempt = state.connectAttempts
      setTimeout(() => {
        if (attempt <= state.handshakeRejects) {
          // ws 的握手被拒走这个事件，**不是** error —— 不接住就会挂到我们自己的超时
          this.emit('unexpected-response', {}, { statusCode: 403 })
        } else if (attempt <= state.connectFails) {
          this.emit('error', new Error(state.connectFailMessage))
        } else {
          this.emit('open')
        }
      }, 0)
    }

    on(ev: string, fn: (...a: any[]) => void) {
      const list = this.handlers.get(ev) || []
      list.push(fn)
      this.handlers.set(ev, list)
      return this
    }
    off(ev: string, fn: (...a: any[]) => void) {
      this.handlers.set(ev, (this.handlers.get(ev) || []).filter((f) => f !== fn))
      return this
    }
    emit(ev: string, ...args: any[]) { for (const f of this.handlers.get(ev) || []) f(...args) }

    send(data: string) {
      state.sentFrames.push(data)
      // 只有 ssml 帧才回吐音频：真实上游是先 config 后 ssml，
      // 若对 config 也回吐，测试就会在"还没说出文本"时收到音频 —— 假象。
      if (!data.includes('Path:ssml')) return
      let i = 0
      const step = () => {
        if (i < state.chunks.length) {
          // 真实帧 = `Path:audio\r\n` + 音频负载。这里照原样拼出来，
          // 否则测的就不是线上那条解析路径（曾因此漏掉"静默吃掉前 11 字节"的 bug）。
          const payload = state.rawFrame
            ? state.chunks[i]
            : Buffer.concat([Buffer.from('Path:audio\r\n'), state.chunks[i]])
          this.emit('message', payload, true)
          i += 1
          setTimeout(step, state.chunkIntervalMs)
          return
        }
        if (state.errorAfterChunk) { this.emit('error', new Error('read ECONNRESET')); return }
        if (state.sendTurnEnd) this.emit('message', Buffer.from('Path:turn.end'), false)
      }
      setTimeout(step, state.firstChunkDelayMs)
    }

    close() { this.emit('close', 1000, Buffer.alloc(0)) }
    terminate() { this.close() }
    pause() { state.socketEvents.push('pause') }
    resume() { state.socketEvents.push('resume') }
  }
  return { default: FakeWebSocket }
})

/** 代理替身：只记下传入的 URL，不去真的建 CONNECT 隧道 */
vi.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: class { constructor(public url: string) {} },
}))

function resetTtsStub(opts: { failFirstN?: number; failMessage?: string } = {}) {
  state.connectAttempts = 0
  state.connectFails = opts.failFirstN ?? 0
  state.connectFailMessage = opts.failMessage ?? 'read ECONNRESET'
  state.handshakeRejects = 0
  state.lastUrl = ''
  state.lastOpts = null
  state.sentFrames = []
  state.chunks = [Buffer.alloc(4096, 7)]
  state.chunkIntervalMs = 0
  state.firstChunkDelayMs = 0
  state.sendTurnEnd = true
  state.errorAfterChunk = false
  state.socketEvents = []
  state.rawFrame = false
}

/**
 * TTS 音色清单的不变量。
 *
 * 清单里加了试听台词（`sample`）之后，最容易犯的错是**复制粘贴忘改名字**：
 * 晓伊的台词里写着"我是晓晓" —— 这种错在真机上听起来只像"音色不对"，很难定位。
 * 所以这里用「台词必须包含自己 label 里的名字」把它钉死。
 */
/**
 * 全球化：按语言分发字幕清单（2026-10-24，D2）。
 *
 * 不变量：**任何 locale 都不会拿到空清单**（设置页空白比音色不对更糟），
 * 且专属语言音色必须排在自己的语言里 —— 否则 `?locale=fr` 却给中文音色，
 * 等于把"选不到母语音色"这个 bug 换个地方复现。
 */
describe('voicesForLocale（按语言分发，D2）', () => {
  it('zh-CN → 含中文专用音色 + 中英通用，且默认音色在清单内', () => {
    const list = voicesForLocale('zh-CN')
    const ids = list.map((v) => v.id)
    expect(ids).toContain('zh-CN-XiaoxiaoNeural')
    expect(ids).toContain('en-US-EmmaMultilingualNeural')
    expect(ids).not.toContain('fr-FR-DeniseNeural')
  })

  it('fr-FR → 含法语音色 + 通用，且不含中文专用音色', () => {
    const ids = voicesForLocale('fr-FR').map((v) => v.id)
    expect(ids).toContain('fr-FR-DeniseNeural')
    expect(ids).toContain('en-US-EmmaMultilingualNeural')
    expect(ids).not.toContain('zh-CN-XiaoxiaoNeural')
  })

  it('未知/空 locale → 至少给通用音色，绝不返回空', () => {
    for (const loc of ['', 'xx-YY', 'tlh']) {
      const list = voicesForLocale(loc)
      expect(list.length, `locale=${loc} 返回空清单`).toBeGreaterThan(0)
      expect(list.every((v) => v.id.includes('Multilingual'))).toBe(true)
    }
  })

  it('默认音色按语言走：fr/es/de 不再被塞英文音色', () => {
    expect(defaultVoiceFor('fr-FR')).toBe('fr-FR-DeniseNeural')
    expect(defaultVoiceFor('es-ES')).toBe('es-ES-ElviraNeural')
    expect(defaultVoiceFor('zh-CN')).toBe('zh-CN-XiaoxiaoNeural')
    expect(defaultVoiceFor('xx-YY')).toBe(defaultVoice())
  })

  it('voiceLang 从 id 前缀取语言（不接受任意字符串）', () => {
    expect(voiceLang('fr-FR-DeniseNeural')).toBe('fr-FR')
    expect(voiceLang('en-US-EmmaMultilingualNeural')).toBe('en-US')
    expect(voiceLang('')).toBe('en-US')
  })
})

describe('TTS_VOICES 音色清单不变量', () => {
  it('每个音色都有试听台词，且台词里提到的是自己的名字', () => {
    for (const v of TTS_VOICES) {
      expect(v.sample, `${v.id} 缺 sample`).toBeTruthy()
      const name = v.label.split('（')[0]
      expect(v.sample.includes(name), `${v.id} 的台词没提自己（${name}）: ${v.sample}`).toBe(true)
    }
  })

  it('台词都带品牌名 SUPERCRZY BOT（"中英文读"的英文部分）', () => {
    for (const v of TTS_VOICES) {
      expect(v.sample, v.id).toContain('SUPERCRZY BOT')
    }
  })

  it('台词长度都在单次合成上限内（否则试听会被后端判超长）', () => {
    for (const v of TTS_VOICES) {
      expect(v.sample.length, v.id).toBeLessThan(TTS_MAX_CHARS)
    }
  })

  it('音色 id 唯一，且默认音色在清单里', () => {
    const ids = TTS_VOICES.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(defaultVoice())
  })

  it('台词与音色能力匹配：中文专用音色必须含中文，中英通用音色必须同时含中英', () => {
    // 2026-10-16 修：原断言假设「非 zh- 前缀 = 纯英文音色」，因此要求台词不含中文。
    // 但 Ava/Emma/Andrew/Brian 是 Edge TTS 的 Multilingual 音色 —— 中英通用，
    // 台词故意中英双写（试听时正好验证两种语言都读得自然）。
    // 按前缀判断已不成立，改为按「音色实际能力」判断：
    //   zh-CN-*      → 中文专用 ⇒ 台词应含中文
    //   *Multilingual* → 中英通用 ⇒ 台词应同时含中英
    for (const v of TTS_VOICES) {
      const hasHan = /[\u4e00-\u9fa5]/.test(v.sample)
      const hasLatin = /[A-Za-z]/.test(v.sample)
      if (v.id.includes('Multilingual')) {
        expect(hasHan, `${v.id} 是中英通用，台词应含中文`).toBe(true)
        expect(hasLatin, `${v.id} 是中英通用，台词应含英文`).toBe(true)
      } else if (v.id.startsWith('zh')) {
        expect(hasHan, `${v.id} 是中文专用，台词应含中文`).toBe(true)
      }
    }
  })

  it('中英通用音色台词里的自称与音色名一致（防止复制粘贴串名）', () => {
    // 2026-10-16 加：四个 Multilingual 音色是批量加的，容易出现
    // 「Andrew 的台词写着我叫 Ava」这类复制粘贴错误 —— 台词读出来会很尴尬。
    for (const v of TTS_VOICES) {
      if (!v.id.includes('Multilingual')) continue
      const name = v.id.replace('en-US-', '').replace('MultilingualNeural', '')
      expect(v.sample, `${v.id} 台词应包含音色名 ${name}`).toContain(name)
    }
  })
})

describe('synthesizeSpeech 入参校验（不发网络请求就挡掉）', () => {
  beforeEach(() => resetTtsStub())

  it('空文本 / 纯空白 → 抛"文本为空"', async () => {
    await expect(synthesizeSpeech('', {})).rejects.toThrow('文本为空')
    await expect(synthesizeSpeech('   ', {})).rejects.toThrow('文本为空')
  })

  it('超长文本 → 抛"文本过长"（提示分句），而不是硬发出去等超时', async () => {
    await expect(synthesizeSpeech('啊'.repeat(TTS_MAX_CHARS + 1), {})).rejects.toThrow('文本过长')
  })

  it('入参类错误一次都不发出去（更不该重试）', async () => {
    await expect(synthesizeSpeech('', {})).rejects.toThrow()
    await expect(synthesizeSpeech('啊'.repeat(TTS_MAX_CHARS + 1), {})).rejects.toThrow()
    expect(state.connectAttempts).toBe(0)
  })
})

/**
 * 退避重试（2026-09-28）。
 *
 * 背景：v1 host（`speech.platform.bing.com`）的 wss 握手在本机网络实测约 3/4 次数被 RST
 * （`read ECONNRESET`，约 0.19s 快速失败），而 `www.bing.com` 同时 5/5 可达。
 *
 * ⚠️ **2026-10-12 更正**：当时把上面这段判为"瞬时抖动"是错的 —— 真因是 v1 host 随
 * Edge Read Aloud 迁 v2 而**分批退役**（重试救不回 host 退役，只有换端点能救）。
 * 但**重试逻辑仍然必要**：v2 上握手也偶发 RST/超时。本组用例测的是"重试这个机制"，与
 * 当时那段错误归因无关，因此保留。
 * 不重试的后果不只是"少一段音频"：前端会整轮回落系统 TTS（听感机械），
 * 设置页试听直接报"服务不可用"。
 */
describe('synthesizeSpeech 退避重试', () => {
  beforeEach(() => resetTtsStub())

  it('瞬时错误（read ECONNRESET）→ 重试后成功，且只试 2 次', async () => {
    resetTtsStub({ failFirstN: 1, failMessage: 'read ECONNRESET' })
    const buf = await synthesizeSpeech('一句测试文本。')
    expect(buf.length).toBeGreaterThan(0)
    expect(state.connectAttempts).toBe(2)
  })

  it('连续瞬时失败 → 一直重试到上限才放弃', async () => {
    resetTtsStub({ failFirstN: 99, failMessage: 'read ECONNRESET' })
    let msg = ''
    try { await synthesizeSpeech('一句测试文本。') } catch (e: any) { msg = e?.message }
    expect(msg).toBe('read ECONNRESET')
    expect(state.connectAttempts).toBe(TTS_MAX_ATTEMPTS)
  })

  it('非瞬时错误（音色不存在）→ 只试 1 次就抛，不浪费时间', async () => {
    resetTtsStub({ failFirstN: 99, failMessage: 'voice not found' })
    let msg = ''
    try { await synthesizeSpeech('一句测试文本。') } catch (e: any) { msg = e?.message }
    expect(msg).toBe('voice not found')
    expect(state.connectAttempts).toBe(1)
  })

  /**
   * 2026-10-12 起整包路径复用 `streamOnce`，"结果 = 各块逐字节拼接"就是它的核心契约。
   * 这条同时钉住两件事：① 复用的确实是同一条协议路径 ② 攒块逻辑没丢字节。
   * （旧实现"写临时文件 → 读回 → 删文件"那条路径已经不存在，对应的"不留垃圾"断言随之失效。）
   */
  it('整包结果 = 流式各块的逐字节拼接', async () => {
    resetTtsStub()
    state.chunks = [Buffer.alloc(4096, 7), Buffer.alloc(5000, 8)]
    const buf = await synthesizeSpeech('一句测试文本。')
    // 两段合计 9096B，未达 16KB 阈值 ⇒ 会在 turn.end 时一次性兜底吐出
    expect(buf.length).toBe(4096 + 5000)
    expect(buf.subarray(0, 1)[0]).toBe(7)
    expect(buf.subarray(4096, 4097)[0]).toBe(8)
  })
})

describe('退避表不变量（改一不改二必然越界）', () => {
  it('长度 = 尝试次数 - 1', () => {
    expect(TTS_RETRY_BACKOFF_MS.length).toBe(TTS_MAX_ATTEMPTS - 1)
  })

  it('退避递增（避免固定间隔正好卡在上游的失败节奏上）', () => {
    for (let i = 1; i < TTS_RETRY_BACKOFF_MS.length; i++) {
      expect(TTS_RETRY_BACKOFF_MS[i]).toBeGreaterThan(TTS_RETRY_BACKOFF_MS[i - 1])
    }
  })
})

describe('输出格式不变量（2026-09-28）', () => {
  /**
   * 为什么要钉住"必须是 mp3"：容器格式**不报错就会静默换掉**，而后果只在 PWA/Safari 上暴露
   * —— 那边 `<audio>` 对 Opus-in-WebM 支持面不稳，用户表现是"点了朗读没声音"，
   * 后端日志一片正常。所以把它写成断言，谁改谁红。
   */
  it('必须是 mp3 容器（别换成 opus/webm —— PWA 在 Safari 上会静默没声音）', () => {
    expect(TTS_OUTPUT_FORMAT).toMatch(/^audio-.+mono-mp3$/)
  })

  it('码率不低于 96kbps（48kbps 对语音偏闷，是"听感不够真人"的叠加因素）', () => {
    const kbps = Number(/audio-\d+khz-(\d+)kbitrate/.exec(TTS_OUTPUT_FORMAT)?.[1] || 0)
    expect(kbps).toBeGreaterThanOrEqual(96)
  })
})

/**
 * 出口代理透传（2026-09-28）。
 *
 * 上游握手实测约 3/4 次数被 RST，退避重试只能抬到 ~75%；**换出口**是唯一能把成功率
 * 拉满的做法。这几条钉住的不是"功能能用"，而是**"不设代理时行为一点没变"**——
 * 后者才是回归风险所在（宿主环境里有 `HTTP_PROXY`，一不小心就会自动采用）。
 */
describe('出口代理 TTS_PROXY（不设 = 直连，行为与改造前逐字一致）', () => {
  const OLD = process.env.TTS_PROXY
  const OLD_HTTP = process.env.HTTP_PROXY
  const OLD_HTTPS = process.env.HTTPS_PROXY
  beforeEach(() => {
    resetTtsStub()
    delete process.env.TTS_PROXY
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
  })
  afterEach(() => {
    for (const [k, v] of [['TTS_PROXY', OLD], ['HTTP_PROXY', OLD_HTTP], ['HTTPS_PROXY', OLD_HTTPS]] as const) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('未设 TTS_PROXY → 不给 ws 传 agent（= 真的直连）', async () => {
    await synthesizeSpeech('一句测试文本。')
    expect(state.lastOpts).toBeTruthy()
    expect(state.lastOpts.agent).toBeUndefined()
  })

  it('只设宿主 HTTP_PROXY/HTTPS_PROXY → 照样直连（不自动采用宿主代理）', async () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:49247'
    process.env.HTTPS_PROXY = 'http://127.0.0.1:49247'
    await synthesizeSpeech('一句测试文本。')
    expect(state.lastOpts.agent).toBeUndefined()
  })

  it('设了 TTS_PROXY → 建出指向它的 agent（URL 不做改写）', async () => {
    process.env.TTS_PROXY = 'http://127.0.0.1:7890'
    await synthesizeSpeech('一句测试文本。')
    expect(state.lastOpts.agent).toBeInstanceOf(HttpsProxyAgent)
    expect((state.lastOpts.agent as any).url).toBe('http://127.0.0.1:7890')
  })

  it('空白值视同未设（`TTS_PROXY=" "` 不该造出一个空代理）', () => {
    process.env.TTS_PROXY = '   '
    expect(ttsProxyFromEnv()).toBeUndefined()
    process.env.TTS_PROXY = ''
    expect(ttsProxyFromEnv()).toBeUndefined()
  })

  /**
   * `socks5://` 必须挡掉：`https-proxy-agent` 忽略协议部分，会把 CONNECT 报文发给 SOCKS 端口，
   * 不报错、只是挂住 → 我们重试 3 次白等十几秒。这种"配了代理反而更慢"最难排查，所以在入口拦。
   */
  it('socks5:// 被忽略并回落到直连（该 agent 只支持 HTTP CONNECT）', async () => {
    process.env.TTS_PROXY = 'socks5://127.0.0.1:1080'
    expect(ttsProxyFromEnv()).toBeUndefined()
    await synthesizeSpeech('一句测试文本。')
    expect(state.lastOpts.agent).toBeUndefined()
  })

  it('http:// 与 https:// 都被接受', () => {
    process.env.TTS_PROXY = 'http://10.0.0.1:7890'
    expect(ttsProxyFromEnv()).toBe('http://10.0.0.1:7890')
    process.env.TTS_PROXY = 'https://proxy.example.com:443'
    expect(ttsProxyFromEnv()).toBe('https://proxy.example.com:443')
  })

  it('代理照常走重试路径（代理本身也会抖）', async () => {
    process.env.TTS_PROXY = 'http://127.0.0.1:7890'
    resetTtsStub({ failFirstN: 1, failMessage: 'read ECONNRESET' })
    const buf = await synthesizeSpeech('一句测试文本。')
    expect(buf.length).toBeGreaterThan(0)
    expect(state.connectAttempts).toBe(2)
    expect((state.lastOpts.agent as any).url).toBe('http://127.0.0.1:7890')
  })
})

describe('isTransientTtsError 分类', () => {
  it('网络类 → 值得重试', () => {
    for (const m of [
      'read ECONNRESET',
      'connect ECONNREFUSED 1.2.3.4:443',
      'Timed out',
      'socket hang up',
      'fetch failed',
      // ⚠️ 同一次 RST 走代理时的措辞完全不同（2026-09-28 实测抓到）
      'Client network socket disconnected before secure TLS connection was established',
    ]) {
      expect(isTransientTtsError(m), m).toBe(true)
    }
  })

  it('入参类 / 空结果 → 不值得重试', () => {
    for (const m of [
      '文本为空',
      '文本过长（2001 字 > 2000），请分句请求',
      '合成结果为空',
      '',
    ]) {
      expect(isTransientTtsError(m), m || '(空串)').toBe(false)
    }
  })

  /**
   * 这条是"按症状匹配、不按错误码匹配"的回归位：
   * 走代理时 TLS 被 RST 的措辞里**没有** ECONNRESET，早先的清单匹配不到 ⇒ 一次都不重试
   * （实测 175ms 快速失败）。一旦有人把这条从清单里删掉，这里必须红。
   */
  it('代理场景的 TLS RST 措辞必须被认成瞬时错误（否则一次都不重试）', () => {
    expect(isTransientTtsError('Client network socket disconnected before secure TLS connection was established')).toBe(true)
  })

  /**
   * 🔴 2026-09-28 17:5x 真机事故的回归位。
   *
   * 我们自己的三个超时文案全是**中文**，而这份清单原来只列英文症状 ⇒ 一条都匹配不到。
   * 后果不是"少重试一次"，而是**一次都不重试**：上游"挂住"（既不 RST 也不回包）时，
   * 3s 判死即 502，而重试预算（TTS_MAX_ATTEMPTS=3）形同死代码。
   * 实测症状：连发 4 次 /api/tts/stream 全部准时 3s 返回 502，朗读条跳一下变"正在用系统音色"。
   *
   * ⚠️ 这条的判据是"**新增的每种超时措辞**都要在清单里"，所以以后改这里的文案，
   *    要么同步改清单，要么红。
   */
  it('我们自己的中文超时文案必须被判成瞬时错误（否则重试预算是死代码）', () => {
    for (const m of ['连接上游超时', '首块超时', '上游数据中断']) {
      expect(isTransientTtsError(m), m).toBe(true)
    }
  })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * 流式合成（2026-09-28「边收边播」）。
 *
 * 为什么这批断言值钱：整条 `/api/tts/stream` 的首声完全押在"首块之前才重试"这条规则上。
 * 规则错了不会报错 —— 只会在真机上表现为**同一句话被念两遍**（重试把已发出的字节又吐一次）
 * 或者**响应头写两套**。所以这里逐条钉死，而不是等到线上听出来。
 */
describe('synthesizeSpeechStream 流式合成', () => {
  beforeEach(() => resetTtsStub())

  it('逐块回调：首块到阈值就出，后续块合并到更大的阈值再出，且内容无损', async () => {
    resetTtsStub()
    state.chunks = [Buffer.alloc(4096, 7), Buffer.alloc(20000, 8), Buffer.alloc(3, 9)]
    const got: Buffer[] = []
    await synthesizeSpeechStream('一句测试文本。', {}, (b) => { got.push(b) })

    // 首块 4096 立即出；20000 攒过 16384 出一块；尾巴 3 字节在 turn.end 时兜底出
    expect(got.map((b) => b.length)).toEqual([4096, 20000, 3])
    expect(Buffer.concat(got).length).toBe(4096 + 20000 + 3)
    // 逐字节保序：不能有任何一块被重排或吞掉
    expect(Buffer.concat(got).subarray(0, 1)[0]).toBe(7)
    expect(Buffer.concat(got).subarray(4096, 4097)[0]).toBe(8)
    expect(Buffer.concat(got).subarray(24096, 24097)[0]).toBe(9)
  })

  it('首块之前失败 → 退避重试（与整包路径同一套规则）', async () => {
    resetTtsStub()
    state.connectFails = 1
    const got: Buffer[] = []
    await synthesizeSpeechStream('一句测试文本。', {}, (b) => { got.push(b) })
    expect(state.connectAttempts).toBe(2)
    expect(got.length).toBeGreaterThan(0)
  })

  /**
   * 🔴 本文件最要紧的一条。
   * 字节一旦回调出去，HTTP 响应头就已经发了 —— 重试等于把同一段音频再吐一遍（叠音），
   * 或者写出第二套响应头。所以"已吐字节后失败"必须**立即上抛、不重试**。
   * 注意这里故障用的是 `read ECONNRESET`（**换任何实现都会判成可重试的瞬时错误**），
   * 于是"没有再连第二次"只可能是被"已吐字节"这条规则挡住的。
   */
  it('已经回调过块之后失败 → 绝不重试（否则会叠音 / 写两套响应头）', async () => {
    resetTtsStub()
    state.chunks = [Buffer.alloc(8192, 1)]
    state.errorAfterChunk = true
    const got: Buffer[] = []
    await expect(synthesizeSpeechStream('一句测试文本。', {}, (b) => { got.push(b) }))
      .rejects.toThrow('read ECONNRESET')
    expect(got.length).toBe(1)
    expect(state.connectAttempts).toBe(1) // ← 关键：没有第二次
  })

  it('入参类错误一次都不发出去（更不该重试）', async () => {
    resetTtsStub()
    await expect(synthesizeSpeechStream('', {}, () => {})).rejects.toThrow('文本为空')
    await expect(synthesizeSpeechStream('   ', {}, () => {})).rejects.toThrow('文本为空')
    await expect(synthesizeSpeechStream('啊'.repeat(TTS_MAX_CHARS + 1), {}, () => {})).rejects.toThrow('文本过长')
    expect(state.connectAttempts).toBe(0)
  })

  it('上游连上但不吐任何块（只有 turn.end）→ 一次回调都没有，也算正常结束', async () => {
    resetTtsStub()
    state.chunks = []
    const got: Buffer[] = []
    await synthesizeSpeechStream('一句测试文本。', {}, (b) => { got.push(b) })
    expect(got).toEqual([])
  })

  /**
   * 防御分支：帧里找不到 `Path:audio\r\n` 时必须**整帧当音频**。
   * 写成 `indexOf(sep) + sep.length` 的话，找不到时 `-1 + 12 = 11` ⇒ 每块都被吃掉前 11 字节，
   * 不报错、只是音频开头缺一小截 —— 这种 bug 只能靠"再听一遍"发现，所以用断言钉住。
   */
  it('二进制帧没带 Path:audio 头 → 整帧当音频（不得吃掉前 11 字节）', async () => {
    resetTtsStub()
    state.rawFrame = true
    state.chunks = [Buffer.alloc(4096, 5)]
    const got: Buffer[] = []
    await synthesizeSpeechStream('一句测试文本。', {}, (b) => { got.push(b) })
    expect(got.length).toBe(1)
    expect(got[0].length).toBe(4096)
  })

  /**
   * 反压。不做这件事的后果很隐蔽：接口行为完全正确，只是**上游按 ~1.7MB/s 吐完的音频
   * 会先在 Node 内存里堆成整包**（1596 字 ≈ 4.5MB），"边收边播"退化成"边收边堆"。
   * 所以它必须是一条断言，而不是注释里的承诺。
   */
  it('onChunk 返回未 resolve 的 Promise → 暂停上游 socket；resolve 后恢复', async () => {
    resetTtsStub()
    state.chunks = [Buffer.alloc(4096, 1), Buffer.alloc(4096, 2)]
    state.chunkIntervalMs = 60
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const seen: number[] = []
    const p = synthesizeSpeechStream('一句测试文本。', {}, (b) => { seen.push(b.length); return gate })
    await sleep(20)
    expect(state.socketEvents).toContain('pause')
    release()
    await p
    expect(state.socketEvents).toContain('resume')
    // 两条一起看才是完整的不变量：只 pause 不 resume 会把流永久卡死
    expect(seen.length).toBeGreaterThan(0)
  })

  it('流式路径不写任何临时文件（整包才会写）', async () => {
    resetTtsStub()
    await synthesizeSpeechStream('一句测试文本。', {}, () => {})
    const { readdir } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const leftovers = (await readdir(tmpdir())).filter((f) => f.startsWith('supercrzy-tts-'))
    expect(leftovers).toEqual([])
  })
})

describe('流式阈值不变量（改一不改二会退化成"逐块抖 2897 次 write"）', () => {
  it('首块阈值 ≤ 后续阈值（首块要快、后续要少）', () => {
    expect(TTS_STREAM_FIRST_FLUSH_BYTES).toBeLessThanOrEqual(TTS_STREAM_FLUSH_BYTES)
  })

  it('首块超时压在 3s 内 —— 这是"再长的文本也不会被超时误杀"的保证', () => {
    // 实测首块恒定 335~602ms（1596 字与 15 字一样快），3s 已是 5× 余量。
    // 写这条是防止有人把它改回"整包 12s"那种越长越容易死的语义。
    expect(TTS_FIRST_CHUNK_TIMEOUT_MS).toBeLessThanOrEqual(3000)
  })

  /**
   * 握手超时与首块超时**必须是两个量**（2026-10-21 手机实测）。
   *
   * 旧实现共用一个 3000ms：手机到上游的 TLS 握手实测 1.3 / 1.5 / 3.7 / **6.1s**（冷启动），
   * 而**进程刚起来的第一条**请求即使给到 8s 也仍然超时（实测总耗时 16.52s = 两次 8s）。
   * 于是定为 12s 并用 `warmUpTts()` 在开机时预热。
   * 这条断言钉的是「不要再把两者合并」：合并的那天，手机端就又开始整轮回落系统音色。
   */
  it('握手超时必须 ≥ 10s 且严格大于首块超时（手机冷启动实测 > 8s）', () => {
    expect(TTS_HANDSHAKE_TIMEOUT_MS).toBeGreaterThanOrEqual(10000)
    expect(TTS_HANDSHAKE_TIMEOUT_MS).toBeGreaterThan(TTS_FIRST_CHUNK_TIMEOUT_MS)
  })

  it('握手超时单独封顶 2 次；其它瞬时错误仍用 3 次', () => {
    expect(TTS_HANDSHAKE_MAX_ATTEMPTS).toBe(2)
    expect(maxAttemptsFor('连接上游超时')).toBe(TTS_HANDSHAKE_MAX_ATTEMPTS)
    expect(maxAttemptsFor('read ECONNRESET')).toBe(TTS_MAX_ATTEMPTS)
    expect(maxAttemptsFor('上游握手失败 HTTP 429')).toBe(TTS_MAX_ATTEMPTS)
  })

  it('输出格式仍必须是 mp3（<audio> 直连流式播放依赖它是可渐进解析的容器）', () => {
    expect(TTS_OUTPUT_FORMAT).toMatch(/^audio-.+mono-mp3$/)
  })
})

/**
 * v2 GEC 端点契约（2026-10-24 第二次迁移后：旧 host + TrustedClientToken + v2 token）。
 *
 * 这批断言的价值在于：迁移后的**每个参数都是"错了就握手失败"的硬约束**，
 * 而它们全藏在 URL 和帧里 —— 一旦有人"顺手"改了 host、把 `TrustedClientToken`
 * 换回 `Ocp-Apim-Subscription-Key`、或把 v2 token 换成 v1 裸哈希，功能会整体哑掉，
 * 但代码看上去毫无问题。所以逐条钉死。
 */
describe('v2 端点契约（迁移后不可"顺手"改动）', () => {
  beforeEach(() => resetTtsStub())

  it('URL 指向旧 host（2026-10-23 复活）与 /edge/v1 路径', async () => {
    await synthesizeSpeech('一句测试文本。')
    expect(state.lastUrl).toMatch(
      /^wss:\/\/speech\.platform\.bing\.com\/consumer\/speech\/synthesize\/readaloud\/edge\/v1\?/,
    )
  })

  it('token 用旧参数名 TrustedClientToken（新 host 的 Ocp-Apim 已随该 host 一起失效）', async () => {
    await synthesizeSpeech('一句测试文本。')
    expect(state.lastUrl).toContain('TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4')
    expect(state.lastUrl).not.toContain('Ocp-Apim-Subscription-Key')
  })

  it('版本号固定 v2 配套的 2-143.0.3650.75', async () => {
    await synthesizeSpeech('一句测试文本。')
    expect(state.lastUrl).toContain('Sec-MS-GEC-Version=2-143.0.3650.75')
  })

  it('每次连接带新的 ConnectionId，且 Sec-MS-GEC 是 v2 格式（16hex-64hex）', async () => {
    await synthesizeSpeech('一句测试文本。')
    const first = state.lastUrl
    expect(first).toMatch(/ConnectionId=[0-9a-f]{32}/)
    expect(first).toMatch(/Sec-MS-GEC=[0-9A-F]{16}-[0-9A-F]{64}/)
    await synthesizeSpeech('另一句。')
    expect(state.lastUrl).not.toBe(first)
  })

  it('speech.config 必须先于 ssml，且显式声明 outputFormat', async () => {
    await synthesizeSpeech('一句测试文本。')
    expect(state.sentFrames.length).toBe(2)
    expect(state.sentFrames[0]).toContain('Path:speech.config')
    // ⚠️ 漏掉 outputFormat 会被服务端以 code=1007 关连接（它会套用 16khz-32k 的默认值）
    expect(state.sentFrames[0]).toContain(TTS_OUTPUT_FORMAT)
    expect(state.sentFrames[1]).toContain('Path:ssml')
    expect(state.sentFrames[1]).toContain('X-Timestamp:')
  })

  it('两帧共用同一个 X-RequestId（= ConnectionId），便于与服务端回帧对上', async () => {
    await synthesizeSpeech('一句测试文本。')
    const idOf = (frame: string) => /X-RequestId:([0-9a-f]{32})/.exec(frame)?.[1]
    expect(idOf(state.sentFrames[0])).toBeTruthy()
    expect(idOf(state.sentFrames[1])).toBe(idOf(state.sentFrames[0]))
    expect(state.lastUrl).toContain(`ConnectionId=${idOf(state.sentFrames[0])}`)
  })

  /**
   * 🔴 `ws` 的握手被拒**不走 `error` 事件**，走的是 `unexpected-response`。
   * 少了那个监听器，"403"会表现为一路挂到 3s 超时后报"连接上游超时"——
   * 把确定性拒绝伪装成网络慢。2026-10-12 排查 TTS 时正是这条把方向带偏过。
   */
  it('握手被拒（403）→ 立刻失败并带上状态码，不挂到超时', async () => {
    resetTtsStub()
    state.handshakeRejects = 99
    const t0 = Date.now()
    let msg = ''
    try { await synthesizeSpeech('一句测试文本。') } catch (e: any) { msg = e?.message }
    expect(msg).toContain('403')
    // 必须远小于 TTS_FIRST_CHUNK_TIMEOUT_MS（3s）：证明是"立刻失败"而非超时兜底
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('逼近上限的长文本也能一次合成完（不再有"整包 12s"那种越长越易被误杀的超时）', async () => {
    resetTtsStub()
    state.chunks = [Buffer.alloc(4096, 1), Buffer.alloc(4096, 2)]
    const buf = await synthesizeSpeech('啊'.repeat(TTS_MAX_CHARS))
    expect(buf.length).toBe(8192)
  })
})

describe('Sec-MS-GEC 签名（v2）', () => {
  it('同一时间点 → 同一签名（纯函数，不是随机数）', () => {
    const t = 1_791_797_744_000
    expect(secMsGec(t)).toBe(secMsGec(t))
    // v2 格式：`<16 hex CS64>-<64 hex SHA256*>`
    expect(secMsGec(t)).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/)
  })

  it('按 5 分钟窗口对齐 —— 窗口内任意时刻相同，跨窗口才变', () => {
    const base = 1_791_797_700_000 // 正好落在 300s 边界上
    expect(secMsGec(base)).toBe(secMsGec(base + 60_000))
    expect(secMsGec(base)).not.toBe(secMsGec(base + 5 * 60_000))
  })

  /**
   * 🔴 本组最关键的一条：**与外来实现比对**，不是拿自己的参考实现比自己。
   *
   * 2026-10-12 的教训：这里的"参考实现"曾经把 `tts.ts` 里的纪元常量原样抄了一遍，
   * 而那个常量少了一位数 ⇒ 断言恒真、单测全绿、线上恒 403。
   * **"测试跟着实现一起错"是这类 bug 唯一的藏身处。**
   *
   * v2 算法（自定义 SHA-256 变体 + CS64）无法再从 npm 包取对照物
   * （`node-edge-tts` 只实现了 v1），所以对照物改为**上游 Python
   * `edge-tts==7.3.1` 的 `generate_sec_ms_gec_v2()` 离线算出的固定字面量**
   * （2026-10-24 本机 stub `drm.py` 实算，6 组时间戳双向 diff 全等）。
   * 改算法必须先用脚本重算这些字面量并人工核对来源。
   */
  it('与上游 Python edge-tts==7.3.1 的离线基准值逐位一致（外来对照物）', () => {
    // key = Unix 秒；value = 上游 generate_sec_ms_gec_v2(ts) 的输出
    const fixtures: Array<[number, string]> = [
      [0, '52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6'],
      [1_500_000_000, 'BEA53E27C8730D2A-262BC008E383061BE8FEA9F27A99067C42E81CCE3BB35D18A96624F0AC3D764B'],
      [1_791_797_744, '9860952DD08E4D03-B337B736562CA4900D094EDBFCDCE2A254D5E02E3AE41020A6FBECD250E5352B'],
      [1_792_822_702, 'A2A9ADB82CB415E1-51A5511C3E12A56F5C76BE52DD9450E21E1B0B8D665B21D7A593C4029D72F78C'],
      [4_102_444_800, 'DD230DB44FEE2FD7-DA0D4FA797866E36C992FABB81DD2F9DB37EB74D675D63228277003DCD3F9F8C'],
    ]
    for (const [ts, expected] of fixtures) {
      expect(secMsGec(ts * 1000)).toBe(expected)
    }
  })

  /**
   * 纪元常量必须**从日期推导**，不能手打 —— 手打的失败方式就是少一位（差 10 倍），
   * 而且症状与"出口被墙"完全同形。这条断言独立于实现的常量本身。
   */
  it('纪元差 = 1601-01-01 → 1970-01-01 的真实秒数（11 位，不是 10 位）', () => {
    const derived = Math.round((Date.UTC(1970, 0, 1) - Date.UTC(1601, 0, 1)) / 1000)
    expect(derived).toBe(11_644_473_600)
    expect(String(derived)).toHaveLength(11)
    // ticks 必须落进 1.3e17 量级；若纪元常量少一位会掉到 ~2.9e16（能过格式校验但服务端拒收）
    const ticks = BigInt(Math.floor(1_791_797_744_123 / 1000) + derived) * 10_000_000n
    expect(ticks.toString()).toHaveLength(18)
  })

  /**
   * 给"用 number 而不是 BigInt"这个坑留的回归位。
   * ticks 量级约 1.34e17 > `Number.MAX_SAFE_INTEGER`(9.0e15)，用普通 number 会**静默丢精度**。
   * 基准值来自上游 Python（2026-10-24 实算，ts=1791797744 恰好与窗口用例同刻）。
   */
  it('与"精确到 ticks 低位"的上游基准值一致（BigInt 不丢精度）', () => {
    const t = 1_791_797_744_123
    expect(secMsGec(t)).toBe(
      '9860952DD08E4D03-B337B736562CA4900D094EDBFCDCE2A254D5E02E3AE41020A6FBECD250E5352B',
    )
  })
})

/**
 * 连接预热池（2026-10-21）。
 *
 * 为什么值得单测：手机实测每段朗读的固定成本是「握手 + 首块」**7.5~10.6s**，
 * 长回复切 N 段就付 N 次 —— 这是"读一段停七八秒"的直接原因。
 * 预热池把这段成本从用户第一次点击里挪走，所以"复用真发生了"必须有断言钉住，
 * 否则它退化成"每次都新建连接"也照样全绿。
 */
describe('连接预热池（省掉每段 7~10s 的握手）', () => {
  const OLD = process.env.TTS_TEST_PREWARM
  beforeEach(() => {
    process.env.TTS_TEST_PREWARM = '1'
    resetTtsStub()
    resetTtsWarmPool()
  })
  afterEach(() => {
    resetTtsWarmPool()
    if (OLD === undefined) delete process.env.TTS_TEST_PREWARM
    else process.env.TTS_TEST_PREWARM = OLD
  })

  it('预热后合成直接复用那条连接：只握手一次，且 speech.config 不会重复发', async () => {
    prewarmTts()
    await new Promise((r) => setTimeout(r, 20))
    expect(state.connectAttempts).toBe(1)
    const configsBefore = state.sentFrames.filter((f) => f.includes('Path:speech.config')).length
    expect(configsBefore).toBe(1) // 预热阶段就把 config 发掉了

    await synthesizeSpeech('一句测试文本。')

    // 关键：ssml 到了，但 config 仍然只有 1 条 —— 说明是**同一条**连接被复用
    //（新建连接会由 streamOnce 再发一次 config）
    expect(state.sentFrames.filter((f) => f.includes('Path:ssml')).length).toBe(1)
    expect(state.sentFrames.filter((f) => f.includes('Path:speech.config')).length).toBe(1)
  })

  it('没有预热连接时照常自己握手（预热只是优化，不能成为依赖）', async () => {
    await synthesizeSpeech('一句测试文本。')
    expect(state.connectAttempts).toBeGreaterThanOrEqual(1)
    expect(state.sentFrames.filter((f) => f.includes('Path:ssml')).length).toBe(1)
  })
})

/**
 * 码率档（2026-10-21）。
 *
 * 为什么要有：96k = 12KB/s，弱网出口（实测手机热点 13KB/s）缓冲必见底；
 * 48k 只要 6KB/s。降档是"能不能听"的问题，不是省流量。
 */
describe('码率档（弱网降到 48k）', () => {
  it('白名单只认 96 / 48，其它一律 null（路由据此 400，不静默回默认）', () => {
    expect(formatForQuality('96')).toBe(TTS_FORMATS['96'])
    expect(formatForQuality('48')).toBe(TTS_FORMATS['48'])
    expect(formatForQuality('32')).toBeNull()
    expect(formatForQuality('')).toBeNull()
    expect(formatForQuality(undefined)).toBeNull()
    expect(formatForQuality('audio-24khz-96kbitrate-mono-mp3')).toBeNull()
  })

  it('两档都必须是可拼接的 mp3 帧流（webm 会带 EBML 头，拼不成一条流）', () => {
    for (const f of Object.values(TTS_FORMATS)) expect(f).toMatch(/^audio-.+mono-mp3$/)
  })

  it('默认档就是 96k（不传 quality 时行为不变）', () => {
    expect(formatForQuality('96')).toBe(TTS_OUTPUT_FORMAT)
  })
})

/**
 * 语言感知音色（2026-10-26）。
 *
 * 修的病：未指定音色时一律落到英文默认音色，于是中文用户听到的是"英文音色读中文" ——
 * 实测同一句中文，英文音色比中文音色**慢 12.8%、过零率（高频噪感）高 39%**，音量却相同，
 * 听感就是"闷、糊、听不清在读什么"。
 *
 * 这些断言钉的是**选择规则**，不是某个具体音色 id —— 换音色不该让测试变成维护负担，
 * 但"中文文本必须拿中文音色"这条不能退化。
 */
describe('pickVoiceForText：按文本语言选音色', () => {
  it('纯中文文本 → 中文音色（不是英文默认）', () => {
    const v = pickVoiceForText('这是一段中文内容，请朗读出来。')
    expect(v).toBe(DEFAULT_VOICE_ZH)
    expect(v.startsWith('zh-')).toBe(true)
  })

  it('纯英文文本 → 英文音色', () => {
    const v = pickVoiceForText('This is an English sentence to be read aloud.')
    expect(v.startsWith('en-')).toBe(true)
  })

  it('中英混排且以中文为主 → 中文音色', () => {
    const v = pickVoiceForText('把这个 API 的返回值打印出来，注意 error 字段。')
    expect(v).toBe(DEFAULT_VOICE_ZH)
  })

  it('纯英文里夹一个中文词 → 仍用英文音色（占比未过阈值）', () => {
    const v = pickVoiceForText('The quick brown fox jumps over the lazy dog while 你 watch the entire experiment carefully.')
    expect(v.startsWith('en-')).toBe(true)
  })

  it('用户显式指定的音色优先，即使语言不匹配', () => {
    expect(pickVoiceForText('这是中文', 'en-US-EmmaMultilingualNeural')).toBe('en-US-EmmaMultilingualNeural')
    expect(pickVoiceForText('This is English', 'zh-CN-YunxiNeural')).toBe('zh-CN-YunxiNeural')
  })

  it('退役音色即便被显式指定也会替换（旧 host 对它们静默挂死）', () => {
    for (const retired of retiredVoices()) {
      expect(pickVoiceForText('任意文本', retired)).not.toBe(retired)
    }
  })

  it('纯标点/空白不触发中文音色（cjkRatio 忽略标点）', () => {
    expect(cjkRatio('，。！？—— …')).toBe(0)
    expect(pickVoiceForText('...')).toBe(pickVoiceForText('Hello'))
  })

  it('cjkRatio 计算正确', () => {
    expect(cjkRatio('中文')).toBe(1)
    expect(cjkRatio('ab')).toBe(0)
    expect(cjkRatio('中a')).toBeCloseTo(0.5, 5)
    expect(cjkRatio('')).toBe(0)
  })
})

/**
 * 语种判定与音色映射（2026-10-26）。
 *
 * 🔴 这里钉住的是一个**已经踩过的坑**：日文正文汉字占比可到 0.45，如果先判汉字再判假名，
 * 日文会被当成中文，然后拿中文音色去读假名。实测证据（同一句日文）：
 *   自动(误判中文)=XiaoxiaoNeural 44352B  vs  正确=NanamiNeural 84960B
 * 所以 detectTtsLang 的判定顺序（假名 → 谚文 → 汉字 → 西里尔 → 拉丁）不能改。
 */
describe('detectTtsLang 语种判定顺序', () => {
  it('日文（汉字占比很高）→ ja，不是 zh', () => {
    const ja = 'これは日本語のテストです。音声が正しく読み上げられているか確認します。'
    expect(cjkRatio(ja)).toBeGreaterThan(0.15) // 汉字确实过阈值 —— 这正是误判来源
    expect(detectTtsLang(ja)).toBe('ja')
  })

  it('韩文 → ko', () => {
    expect(detectTtsLang('이것은 한국어 테스트입니다.')).toBe('ko')
  })

  it('中文 → zh', () => {
    expect(detectTtsLang('这是一段中文内容，请朗读出来。')).toBe('zh')
  })

  it('俄文（西里尔）→ ru', () => {
    expect(detectTtsLang('Это тест на русском языке.')).toBe('ru')
  })

  it('英文 → en', () => {
    expect(detectTtsLang('This is an English sentence.')).toBe('en')
  })
})

describe('pickVoiceForText 语种 → 音色映射', () => {
  const cases: Array<[string, string, string]> = [
    ['日文', 'これは日本語のテストです。', 'ja'],
    ['韩文', '이것은 한국어 테스트입니다.', 'ko'],
    ['中文', '这是中文测试。', 'zh'],
    ['俄文', 'Это тест на русском языке.', 'ru'],
  ]
  for (const [label, text, lang] of cases) {
    it(`${label} → 该语种的专用音色（前缀 ${lang}-）`, () => {
      const v = pickVoiceForText(text)
      expect(v.startsWith(`${lang}-`)).toBe(true)
      // 专用音色必须是母语音色，不能是英文多语言音色
      expect(v.includes('Multilingual')).toBe(false)
    })
  }

  it('日文绝不能用中文音色（历史 bug 的回归保护）', () => {
    const v = pickVoiceForText('これは日本語のテストです。音声を確認します。')
    expect(v.startsWith('zh-')).toBe(false)
  })
})
