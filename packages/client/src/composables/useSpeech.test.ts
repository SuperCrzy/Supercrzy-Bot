// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { useSpeech, PRO_COOLDOWN_MS } from './useSpeech'

/** ---- 环境 mock：系统 TTS + fetch + Audio + ObjectURL ---- */
function installMocks(opts: { fetchOk?: boolean; voices?: { name: string; lang: string }[]; failFirstN?: number; failAfter?: number } = {}) {
  const calls = { speak: 0, pause: 0, resume: 0, cancel: 0, fetch: 0, audioPlay: 0, audioPause: 0 }
  let lastUtterance: any = null
  let fetchCalls = 0
  const audios: any[] = []
  const picked: any[] = []
  const requestedTexts: string[] = []
  const requestedUrls: string[] = []

  const synth = {
    get speaking() { return calls.speak > 0 },
    getVoices: () => opts.voices ?? [{ name: 'Tingting', lang: 'zh-CN' }],
    speak: (u: any) => { calls.speak++; lastUtterance = u; picked.push(u.voice) },
    pause: () => { calls.pause++ },
    resume: () => { calls.resume++ },
    cancel: () => { calls.cancel++ },
  }
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true })
  ;(globalThis as any).SpeechSynthesisUtterance = class {
    text: string
    voice: any = null
    lang = ''
    rate = 1
    pitch = 1
    onend: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(text: string) { this.text = text }
  }

  class FakeAudio {
    src: string
    onended: (() => void) | null = null
    onerror: (() => void) | null = null
    /** 2026-09-28：流式播放靠它判定"真的出声了"（合成窗口结束的信号） */
    onplaying: (() => void) | null = null
    paused = false
    constructor(url: string) { this.src = url; audios.push(this) }
    play() { calls.audioPlay++; this.paused = false; return Promise.resolve() }
    pause() { calls.audioPause++; this.paused = true }
    /** 清 src 才等于断开流式下载（pause() 只停播放，下载会继续） */
    removeAttribute(_name: string) { this.src = '' }
    load() { /* noop */ }
  }
  ;(globalThis as any).Audio = FakeAudio
  ;(globalThis as any).URL.createObjectURL = () => 'blob:fake-' + Math.random()
  ;(globalThis as any).URL.revokeObjectURL = () => {}

  globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
    calls.fetch++
    fetchCalls++
    requestedUrls.push(String(_url))
    // 记录被请求的文本：唯一可靠的"有没有重复请求同一包"的判据。
    // ⚠️ 别用"请求次数"当判据 —— 预取下一包是**正确行为**，次数本来就会涨；
    //    真正要钉的是"同一段文本不被请求两次"（否则一次朗读会多付 N 次 wss 握手）。
    try {
      const b = JSON.parse(String(init?.body || '{}'))
      if (b?.text) requestedTexts.push(String(b.text))
    } catch { /* 非 JSON body */ }
    const shouldFail =
      opts.fetchOk === false ||
      fetchCalls <= (opts.failFirstN ?? 0) ||
      (opts.failAfter !== undefined && fetchCalls > opts.failAfter)
    if (shouldFail) return { ok: false, status: 400, json: async () => ({ error: 'read ECONNRESET' }) } as any
    // 2026-09-28：Pro 档唯一的 fetch 是"换票"（POST /api/tts/ticket）→ { token }。
    // 音频**不再经过前端**（没有 blob 中转、没有 createObjectURL），
    // 由 `<audio src="/api/tts/stream?t=...">` 自己边收边播。
    return {
      ok: true,
      status: 200,
      json: async () => ({ token: 'a'.repeat(48) }),
      // 谁要是又把音频改成 blob 中转，这里会立刻炸而不是"看起来还能用"
      blob: async () => { throw new Error('不该再用 blob 中转音频：<audio> 应直连 /api/tts/stream') },
    } as any
  }) as any

  return { calls, audios, picked, requestedTexts, requestedUrls, getUtterance: () => lastUtterance }
}

function withSpeech() {
  const scope = effectScope()
  const api = scope.run(() => useSpeech())!
  return { api, dispose: () => scope.stop() }
}

describe('useSpeech (Pro: Edge TTS)', () => {
  let mock: ReturnType<typeof installMocks>
  beforeEach(() => { mock = installMocks() })

  it('speak 走 Pro：请求 /api/tts 并播放音频', async () => {
    const { api } = withSpeech()
    api.speak('m1', '第一句。第二句。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.calls.fetch).toBeGreaterThan(0)
    expect(mock.audios.length).toBe(1)
    expect(mock.calls.audioPlay).toBe(1)
    expect(api.speakingId.value).toBe('m1')
    expect(mock.calls.speak).toBe(0) // 未走系统 TTS
  })

  it('一条正常回复只发 1 次请求（不再按句切 ⇒ 中途没有"等下一段合成"的空档）', async () => {
    const { api } = withSpeech()
    const text = '这是一段用于测试朗读的长文本。'.repeat(20) // 340 字，远小于单包上限
    api.speak('m1', text)
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.calls.fetch).toBe(1)
    expect(mock.audios.length).toBe(1)
    expect(mock.calls.audioPlay).toBe(1)
    api.stop()
  })

  it('超过单包上限才分包，且顺序播放', async () => {
    const { api } = withSpeech()
    // 4250 字 > 单包上限 2000 → 切 3 包（这是唯一该分包的情形）
    const longText = '这是一段用于测试分句播放的长文本。'.repeat(250)
    api.speak('m1', longText)
    await new Promise((r) => setTimeout(r, 30))
    // 2026-10-21：预取已改成"提前建 <audio> 并 load()"⇒ 此时是
    // 第 1 包在播 + 第 2 包已在缓冲（不是抢播，audioPlay 仍为 1）
    expect(mock.audios.length).toBe(2)
    expect(mock.calls.audioPlay).toBe(1)
    mock.audios[0].onended()
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.calls.audioPlay).toBe(2)   // 第 2 包接着播（用的是预取好的元素）
    expect(mock.audios.length).toBe(3)     // 同时第 3 包已开始预取
    expect(api.speakingId.value).toBe('m1')
  })

  it('全部播完自动复位', async () => {
    const { api } = withSpeech()
    api.speak('m1', '只有一句。')
    await new Promise((r) => setTimeout(r, 30))
    mock.audios[0].onended()
    await new Promise((r) => setTimeout(r, 30))
    expect(api.speakingId.value).toBe(null)
  })

  it('pause/resume 控制 audio', async () => {
    const { api } = withSpeech()
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 30))
    api.pause()
    expect(api.paused.value).toBe(true)
    expect(mock.calls.audioPause).toBe(1)
    api.resume()
    expect(api.paused.value).toBe(false)
    expect(mock.calls.audioPlay).toBe(2)
  })

  it('后端失败 → 自动回落 Lite（系统 TTS）', async () => {
    mock = installMocks({ fetchOk: false })
    const { api } = withSpeech()
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 40))
    expect(mock.calls.speak).toBe(1)
    expect(mock.getUtterance().text).toContain('第一句')
    expect(api.speakingId.value).toBe('m1')
  })

  /**
   * 2026-10-21：Lite 曾硬写 `u.rate = 1`，于是降级时**音色和语速同时变**
   * （用户在设置里选了 +20%，回落系统音色后回到 1.0），听感像"换了个功能"。
   */
  it('降级到 Lite 时保留设置语速（+20% → rate 1.2）', async () => {
    mock = installMocks({ fetchOk: false })
    const scope = effectScope()
    const api = scope.run(() => useSpeech({ rate: () => '+20%' }))!
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 40))
    expect(mock.calls.speak).toBe(1)
    expect(mock.getUtterance().rate).toBeCloseTo(1.2, 5)
    scope.stop()
  })

  it('rate 缺省/无法解析 → 保持 1.0（不能因为解析失败就静默降速）', async () => {
    mock = installMocks({ fetchOk: false })
    const scope = effectScope()
    const api = scope.run(() => useSpeech({ rate: () => 'default' }))!
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 40))
    expect(mock.getUtterance().rate).toBe(1)
    scope.stop()
  })

  it('单例：读新的自动停旧的', async () => {
    const { api } = withSpeech()
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 30))
    api.speak('m2', '另一句。')
    await new Promise((r) => setTimeout(r, 30))
    expect(api.speakingId.value).toBe('m2')
  })

  it('stop 复位', async () => {
    const { api } = withSpeech()
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 30))
    api.stop()
    expect(api.speakingId.value).toBe(null)
    expect(api.paused.value).toBe(false)
  })
})

describe('useSpeech (Lite: 系统 TTS)', () => {
  let mock: ReturnType<typeof installMocks>
  beforeEach(() => { mock = installMocks({ fetchOk: false }) })

  it('toggle 同一条：播放中→暂停，暂停中→继续', async () => {
    const { api } = withSpeech()
    api.toggle('m1', '文本。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.calls.speak).toBe(1)
    api.toggle('m1', '文本。')
    expect(api.paused.value).toBe(true)
    expect(mock.calls.pause).toBe(1)
    api.toggle('m1', '文本。')
    expect(api.paused.value).toBe(false)
    expect(mock.calls.resume).toBe(1)
  })

  it('空文本不朗读', () => {
    const { api } = withSpeech()
    api.speak('m1', '   ')
    expect(api.speakingId.value).toBe(null)
    expect(mock.calls.speak).toBe(0)
  })

  it('朗读结束（onend）自动复位', async () => {
    const { api } = withSpeech()
    api.speak('m1', '文本。')
    await new Promise((r) => setTimeout(r, 30))
    mock.getUtterance().onend()
    expect(api.speakingId.value).toBe(null)
  })
})

/**
 * Pro 失败后的「冷却」语义（2026-09-28 改造）。
 *
 * 原实现是一次失败即 `proDisabled = true` **本会话永久**失效 —— 上游抖一下就整个会话
 * 用系统拼接音色，且**没有任何提示**（老板就是因为这个以为"朗读音色是机械化的"）。
 * 这三条钉死改造后的行为：冷却期内不空试、到期自动恢复、降级态对 UI 可见。
 */
describe('useSpeech Pro 冷却（不再一次失败永久回落）', () => {
  let mock: ReturnType<typeof installMocks>

  beforeEach(() => {
    // 只伪造 Date：真实 setTimeout 仍要能用（测试里靠它等异步链路走完）
    vi.useFakeTimers({ toFake: ['Date'] })
    mock = installMocks({ failFirstN: 1 })
  })
  afterEach(() => vi.useRealTimers())

  it('第一次失败**不换音色**：改用整条一次请求再试 Pro，成功后不降级', async () => {
    const { api } = withSpeech()
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 40))
    // 2026-10-21 改：一次失败只是握手抖动，换系统音色是最后手段
    expect(mock.calls.fetch).toBe(2)          // ← 换票失败 1 次 + 整条重试 1 次
    expect(mock.calls.speak).toBe(0)          // 没有走系统 TTS
    expect(api.proDegraded.value).toBe(false) // 提示不亮：音色没变
    expect(api.isPro()).toBe(true)            // 也没有进冷却
    expect(api.speakingId.value).toBe('m1')
  })

  it('连续两次失败 → 才降到 Lite，并进冷却', async () => {
    mock = installMocks({ failFirstN: 2 }) // 换票失败 + 整条重试也失败
    const { api } = withSpeech()
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 40))
    expect(mock.calls.fetch).toBe(2)
    expect(mock.calls.speak).toBe(1)
    expect(api.proDegraded.value).toBe(true)
    expect(api.isPro()).toBe(false)
    expect(api.speakingId.value).toBe('m1')
  })

  it('冷却期内再朗读 → 不再空试 Pro（省掉注定失败的那次请求）', async () => {
    mock = installMocks({ failFirstN: 2 })
    const { api } = withSpeech()
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 40))
    expect(mock.calls.fetch).toBe(2)

    api.speak('m2', '第二句。')
    await new Promise((r) => setTimeout(r, 40))
    expect(mock.calls.fetch).toBe(2) // ← 关键：没有再多发一次
    expect(mock.calls.speak).toBe(2)
    expect(api.speakingId.value).toBe('m2')
  })

  it('冷却到期 → 自动重试 Pro，成功后撤下降级态', async () => {
    mock = installMocks({ failFirstN: 2 })
    const { api } = withSpeech()
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 40))
    expect(api.proDegraded.value).toBe(true)

    vi.setSystemTime(Date.now() + PRO_COOLDOWN_MS + 1)
    api.speak('m2', '第二句。')
    await new Promise((r) => setTimeout(r, 40))
    expect(mock.calls.fetch).toBe(3)          // ← 关键：真的又试了 Pro
    expect(mock.calls.speak).toBe(1)          // 没有再走 Lite（仍是首次失败那 1 次）
    // 撤下降级态的时机是**真的出声**，不是"换票成功"：换票只是本地一次 POST，
    // 上游还挂着时票据照样换得到 —— 那时就撤提示会"先消失再弹回来"。
    expect(api.proDegraded.value).toBe(true)  // 还没出声 → 提示仍挂着
    mock.audios[0].onplaying?.()
    expect(api.proDegraded.value).toBe(false) // 出声了 → 提示消失
    expect(api.isPro()).toBe(true)
  })

  it('冷却期内 isPro() 为 false（供设置项等非响应式场景判断）', async () => {
    mock = installMocks({ failFirstN: 2 })
    const { api } = withSpeech()
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 40))
    expect(api.isPro()).toBe(false)
  })
})

/**
 * 流式朗读（2026-09-28「边生成边朗读」）。
 *
 * 与整条路径**唯一的行为分叉**在第 1 条用例：队列播空时不能收尾，得停车等下一块。
 * 这条如果破了，症状是"只念出第一块，后面生成的正文永远读不到"，
 * 而它看起来"很像正常结束"（speakingId 归零、按钮复位）—— 所以必须有点名用例。
 */
describe('useSpeech 流式（边生成边朗读）', () => {
  let mock: ReturnType<typeof installMocks>
  beforeEach(() => { mock = installMocks() })

  it('队列播空**不收尾**，等下一块到达再续播', async () => {
    const { api } = withSpeech()
    expect(api.beginStream('m1')).toBe(true)
    api.appendStreamText('第一块。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.audios.length).toBe(1)
    expect(mock.calls.audioPlay).toBe(1)

    mock.audios[0].onended() // 第一块播完，此刻还没有第二块
    await new Promise((r) => setTimeout(r, 30))
    expect(api.speakingId.value).toBe('m1')  // ← 不收尾
    expect(mock.calls.fetch).toBe(1)         // 也不去空请求

    api.appendStreamText('第二块。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.audios.length).toBe(2)
    expect(mock.calls.audioPlay).toBe(2)
  })

  /**
   * 2026-09-28 修的真 bug（配合正文真流式转发）：`ensurePrefetch` 原先只在"上一包音频取回后"
   * 触发一次，那时队尾还没长出来 ⇒ 流式下唯一能取下一块的时机变成"当前块播完的 onended"。
   * 第 0 块是 204 字 ≈ 40s 音频 ⇒ 第 1 块整整晚 40s 才开始合成，块间必然插一段静音空档。
   *
   * 三条断言合起来才是**不变量**（缺一条都会被"旧实现"蒙混过去）：
   *   ① 追加即预取：第二块的文本已被请求，但 audios 仍是 1（取了、没抢播）
   *   ② 再追加不重复请求：请求数不增（按 index 去重，不 drop 在途预取）
   *   ③ 切块时复用预取：audio 变 2 且**没有任何文本被请求两次**
   */
  it('追加新块时**立即预取下一块的音频**（不等当前块播完），且不重复请求同一包', async () => {
    const { api } = withSpeech()
    api.beginStream('m1')
    api.appendStreamText('第一块。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.calls.fetch).toBe(1)
    expect(mock.audios.length).toBe(1)

    // 第一块还在播（**不**调 onended）时追加第二块
    api.appendStreamText('第二块。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.requestedTexts).toContain('第二块。') // ① 提前换票
    // ② 而且已经建好 <audio> 在缓冲（≥2：可能还叠了一个刚落地的槽）
    expect(mock.audios.length).toBeGreaterThanOrEqual(2)
    expect(mock.calls.audioPlay).toBe(1)              // 但没有抢播

    // 继续追加第三块：预取的仍是 queueIndex+1（同一包）→ 不得重复请求
    const nAfterSecond = mock.calls.fetch
    api.appendStreamText('第三块。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.calls.fetch).toBe(nAfterSecond)       // ② 去重

    // 第一块播完 → 切到第二块，应当直接吃掉预取结果（不会再为它请求一次）
    mock.audios[0].onended()
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.calls.audioPlay).toBe(2)              // 第二块接着播
    expect(mock.audios.length).toBe(3)                // 第三块已在预取缓冲
    // ③ 全局不变量：同一段文本绝不被请求两次
    expect(new Set(mock.requestedTexts).size).toBe(mock.requestedTexts.length)
    expect(mock.requestedTexts.filter((t) => t === '第二块。').length).toBe(1)
  })

  it('endStream 后队列播完才复位', async () => {
    const { api } = withSpeech()
    api.beginStream('m1')
    api.appendStreamText('第一块。')
    await new Promise((r) => setTimeout(r, 30))
    api.endStream()
    mock.audios[0].onended()
    await new Promise((r) => setTimeout(r, 30))
    expect(api.speakingId.value).toBe(null)
  })

  it('没攒到任何块就 endStream → 直接收尾（不留悬挂的 speakingId）', async () => {
    const { api } = withSpeech()
    api.beginStream('m1')
    expect(api.speakingId.value).toBe('m1')
    api.endStream()
    expect(api.speakingId.value).toBe(null)
  })

  it('Pro 冷却中 beginStream 返回 false，且**不打断**正在进行的朗读', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      mock = installMocks({ failFirstN: 2 }) // 两次失败才进冷却（一次失败会走整条重试）
      const { api } = withSpeech()
      api.speak('m0', '第一句。')
      await new Promise((r) => setTimeout(r, 40))
      expect(api.proDegraded.value).toBe(true)
      expect(api.speakingId.value).toBe('m0')
      // 拒绝开流式 → 调用方应回落整条读；此时 m0 的 Lite 朗读不该被顺手掐掉
      expect(api.beginStream('m1')).toBe(false)
      expect(api.speakingId.value).toBe('m0')
    } finally {
      vi.useRealTimers()
    }
  })

  it('流式中途失败 → 收尾，且**不回落 Lite 重读**（避免重复念一遍）', async () => {
    mock = installMocks({ failAfter: 1 }) // 第 2 次请求开始失败
    const { api } = withSpeech()
    api.beginStream('m1')
    api.appendStreamText('第一块。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.calls.audioPlay).toBe(1)

    mock.audios[0].onended()
    await new Promise((r) => setTimeout(r, 30))
    api.appendStreamText('第二块。')
    await new Promise((r) => setTimeout(r, 40))

    expect(api.proDegraded.value).toBe(true)
    expect(api.speakingId.value).toBe(null) // ← 收尾
    expect(mock.calls.speak).toBe(0)        // ← 没有走系统 TTS 重读
  })

  it('非流式模式下 appendStreamText 是空操作（不会凭空起播）', async () => {
    const { api } = withSpeech()
    api.appendStreamText('野块。')
    await new Promise((r) => setTimeout(r, 30))
    expect(api.speakingId.value).toBe(null)
    expect(mock.calls.fetch).toBe(0)
    expect(mock.audios.length).toBe(0)
  })

  it('stop 清掉流式状态：之后再 append 不会续播', async () => {
    const { api } = withSpeech()
    api.beginStream('m1')
    api.appendStreamText('第一块。')
    await new Promise((r) => setTimeout(r, 30))
    api.stop()
    expect(api.speakingId.value).toBe(null)
    api.appendStreamText('第二块。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.audios.length).toBe(1)
  })
})

/**
 * Lite 兜底音色的优选顺序（2026-09-28 重排）。
 *
 * 原来首项是 `Tingting/婷婷` —— macOS 上那是**拼接式**老音色，听感最机械，
 * 等于我们主动挑了最差的一个；而 macOS 新代 Siri 神经音色（Shelley 等）原来的表里
 * 一个都没列。这三条防止顺序被改回去。
 */
describe('Lite 兜底音色优选顺序', () => {
  let mock: ReturnType<typeof installMocks>

  it('有 Siri 神经音色时不再选「婷婷」', async () => {
    mock = installMocks({
      fetchOk: false,
      voices: [
        { name: '婷婷', lang: 'zh-CN' },
        { name: 'Shelley (中文（中国大陆）)', lang: 'zh-CN' },
        { name: 'Eddy (中文（中国大陆）)', lang: 'zh-CN' },
      ],
    })
    const { api } = withSpeech()
    api.speak('m1', '文本。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.picked[0].name).toContain('Shelley')
  })

  it('同名音色有大陆/台湾两版 → 选大陆版（否则读出台湾腔）', async () => {
    mock = installMocks({
      fetchOk: false,
      voices: [
        { name: 'Shelley (中文（台湾）)', lang: 'zh-TW' }, // 故意把台湾版排在前面
        { name: 'Shelley (中文（中国大陆）)', lang: 'zh-CN' },
      ],
    })
    const { api } = withSpeech()
    api.speak('m1', '文本。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.picked[0].lang).toBe('zh-CN')
  })

  it('只有拼接式老音色时仍要出声（不能因为"不好听"就哑掉）', async () => {
    mock = installMocks({ fetchOk: false, voices: [{ name: 'Tingting', lang: 'zh-CN' }] })
    const { api } = withSpeech()
    api.speak('m1', '文本。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.picked[0].name).toBe('Tingting')
  })
})

/**
 * Pro 整条路径改为「换票 + `<audio>` 直连流式 URL」（2026-09-28）。
 *
 * 背景：整包等合成完再出声，首声要 2.6~18.9s（实测 1596 字）。而服务端边收边下发之后，
 * 首声只由"上游首块"决定（实测 335~602ms，与文本长度无关）。
 *
 * 这里钉三件事：
 *   ① 音频不再经过前端 blob 中转（否则首声又变成"整包到达"）
 *   ② 合成窗口对 UI 可见（`synthesizing`），否则用户会在窗口里重复点击
 *   ③ 重复点击**不能**把状态打成"暂停" —— 那是真机复现过的静音死路
 */
describe('useSpeech Pro 整条 → 流式 URL（2026-09-28）', () => {
  let mock: ReturnType<typeof installMocks>
  beforeEach(() => { mock = installMocks() })

  it('先换票，再让 <audio> 直连流式 URL（音频不再走 blob 中转）', async () => {
    const { api } = withSpeech()
    api.speak('m1', '第一句。第二句。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.requestedUrls).toEqual(['/api/tts/ticket'])
    expect(mock.audios.length).toBe(1)
    expect(mock.audios[0].src).toMatch(/^\/api\/tts\/stream\?t=/)
    expect(mock.calls.audioPlay).toBe(1)
  })

  it('synthesizing：点下去即为真，**真的出声**（playing）后才归假', async () => {
    const { api } = withSpeech()
    expect(api.synthesizing.value).toBe(false)
    api.speak('m1', '第一句。')
    expect(api.synthesizing.value).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(api.synthesizing.value).toBe(true) // 还没出声 —— UI 此刻显示"正在合成语音"
    mock.audios[0].onplaying?.()
    expect(api.synthesizing.value).toBe(false)
  })

  /**
   * 🔴 真机复现过的静音死路（2026-09-28）。
   *
   * 旧实现：`pause()` 无条件置 `paused = true`。而合成期 `currentAudio` 还没建出来
   * ⇒ 第二次点击"暂停"了空气，等音频到达时 `playProIndex` 走"就位不播"，
   * **一次 `play()` 都不调** —— 实测 play 调用 []、出声 []，界面却显示"朗读已暂停"。
   * 这条断言同时钉住"不置 paused"和"必须真的播"两个半边，缺任一半旧实现都能蒙混过去。
   */
  it('合成期再点一次 → 不得置 paused，且音频到了必须真的播（静音死路回归）', async () => {
    const { api } = withSpeech()
    api.speak('m1', '第一句。第二句。')
    expect(api.synthesizing.value).toBe(true)

    api.toggle('m1', '') // 用户以为没反应，又点了一次
    expect(api.paused.value).toBe(false) // ← 关键：不能变成"暂停"

    await new Promise((r) => setTimeout(r, 30))
    expect(mock.calls.audioPlay).toBe(1) // ← 而且音频到了要真的播
    expect(mock.calls.audioPause).toBe(0)
  })

  it('真的在播时点暂停**仍然有效**（修 bug 不能把正常暂停一起关掉）', async () => {
    const { api } = withSpeech()
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 30))
    mock.audios[0].onplaying?.()
    api.pause()
    expect(api.paused.value).toBe(true)
    expect(mock.calls.audioPause).toBe(1)
  })

  it('stop 要清掉 <audio> 的 src —— 否则流式下载不会停，上游白合成一整段', async () => {
    const { api } = withSpeech()
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.audios[0].src).not.toBe('')
    api.stop()
    expect(mock.audios[0].src).toBe('')
  })

  it('流式块也走同一条流式路径（块更小 ⇒ 首声更早，且不再下 blob）', async () => {
    const { api } = withSpeech()
    api.beginStream('m1')
    api.appendStreamText('第一块。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.requestedUrls).toEqual(['/api/tts/ticket'])
    expect(mock.audios[0].src).toMatch(/^\/api\/tts\/stream\?t=/)
  })

  /**
   * 🔴 改造引入的新失败面（2026-09-28）。
   *
   * 音频绕开前端之后，"上游坏了"**再也无法在 fetch 阶段捕获** —— 换票几乎不失败，
   * 真正的失败只在 `<audio>` 的 error 事件里可见。而 error 拿不到 HTTP 状态码
   * （MediaError 只有 code），"票据过期 410（可自愈）"与"上游故障 502（该冷却）"
   * 长得一模一样。这三条钉死这个分叉：一声没出 → 给一次换票重试；
   * 重试还错 / 已经出过声 → 才当真的坏。
   */
  it('一声没出就 error → 换新票重播**同一块**（票据失效可自愈，不能哑掉）', async () => {
    const { api } = withSpeech()
    api.speak('m1', '第一句。第二句。')
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.audios.length).toBe(1)

    mock.audios[0].onerror?.() // 首块之前就断了（如票据过期 410）
    await new Promise((r) => setTimeout(r, 30))

    expect(mock.calls.fetch).toBe(2)          // ← 换了第二张票
    expect(mock.audios.length).toBe(2)        // ← 建了新的 <audio>
    expect(mock.calls.audioPlay).toBe(2)      // ← 不是哑掉，而是真的又播了
    expect(api.proDegraded.value).toBe(false) // 还不到降级的地步
    expect(api.speakingId.value).toBe('m1')
    // 同一块重播：请求的文本仍是同一条，没有跳到别的块、也没有重复念整轮
    expect(new Set(mock.requestedTexts).size).toBe(1)
  })

  it('块内重试也失败 → 整条再重试一次；仍失败才降级（换音色是最后手段）', async () => {
    const { api } = withSpeech()
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 30))

    mock.audios[0].onerror?.() // 第一次：换票重播同一块
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.audios.length).toBe(2)
    expect(mock.calls.speak).toBe(0)

    mock.audios[1].onerror?.() // 第二次：块内额度用完 → 改用整条一次请求再试 Pro
    await new Promise((r) => setTimeout(r, 30))
    expect(mock.audios.length).toBe(3)
    expect(mock.calls.speak).toBe(0)          // ← 仍然没换音色
    expect(api.proDegraded.value).toBe(false)

    mock.audios[2].onerror?.() // 第三次：整条重试也失败 → 这一步才降级
    await new Promise((r) => setTimeout(r, 30))

    expect(mock.audios.length).toBe(3)        // ← 不再新建（没完没了地重试）
    expect(api.proDegraded.value).toBe(true)  // ← 降级提示亮起
    expect(api.isPro()).toBe(false)           // ← 进冷却，短期内不再空试
    expect(mock.calls.speak).toBe(1)          // ← 剩余文本交给系统 TTS，不是静音结束
  })

  it('已经出过声再 error → **绝不重播**（一声都不能叠），直接判失败', async () => {
    const { api } = withSpeech()
    api.speak('m1', '第一句。')
    await new Promise((r) => setTimeout(r, 30))
    mock.audios[0].onplaying?.() // 这一块已经出声了

    mock.audios[0].onerror?.()   // 播到一半断流
    await new Promise((r) => setTimeout(r, 30))

    expect(mock.audios.length).toBe(1)        // ← 关键：没有重播同一块
    expect(mock.calls.audioPlay).toBe(1)
    expect(api.proDegraded.value).toBe(true)
    expect(mock.calls.speak).toBe(1)
  })
})

/**
 * 会话式朗读（2026-10-21）：一条消息一条流。
 *
 * 这里只钉"接线对不对"：**只建一个 <audio>**、指向会话流、push/end 打到对应接口。
 * 真正的无缝性由服务端保证（连续 mp3 帧流），前端不该出现第二个音频元素。
 */
describe('useSpeech 会话式流（一条消息一条流）', () => {
  const TOKEN = 'a'.repeat(48)
  let calls: { url: string; body: any }[] = []

  function installLiveFetch(opts: { createOk?: boolean } = {}) {
    calls = []
    globalThis.fetch = vi.fn(async (u: any, init?: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      calls.push({ url: String(u), body })
      if (String(u) === '/api/tts/live') {
        if (opts.createOk === false) return { ok: false, status: 500, json: async () => ({}) } as any
        return { ok: true, json: async () => ({ token: TOKEN, url: `/api/tts/live/stream?t=${TOKEN}` }) } as any
      }
      return { ok: true, json: async () => ({ ok: true }) } as any
    }) as any
  }

  it('beginLive 只建一个 <audio> 指向会话流；push/end 打到对应接口', async () => {
    const mock = installMocks()
    installLiveFetch()
    const { api } = withSpeech()

    const ok = await api.beginLive('m1')
    await new Promise((r) => setTimeout(r, 10))

    expect(ok).toBe(true)
    expect(mock.audios.length).toBe(1)                       // ← 关键：只有一个音频元素
    expect(mock.audios[0].src).toContain('/api/tts/live/stream')
    expect(api.speakingId.value).toBe('m1')
    expect(api.isLive()).toBe(true)

    api.pushLive('第二段。')
    api.pushLive('第三段。')
    api.endLive()
    await new Promise((r) => setTimeout(r, 10))

    const urls = calls.map((c) => c.url)
    expect(urls.filter((u) => u === '/api/tts/live/push').length).toBe(2)
    expect(urls).toContain('/api/tts/live/end')
    expect(api.isLive()).toBe(false) // end 之后不再持有 token
  })

  it('开会话失败 → 返回 false（调用方据此回退逐段/整条）', async () => {
    const mock = installMocks()
    installLiveFetch({ createOk: false })
    const { api } = withSpeech()
    const ok = await api.beginLive('m1')
    expect(ok).toBe(false)
    expect(mock.audios.length).toBe(0)
  })

  it('stop 会掐掉会话流（<audio> 一断，服务端就 destroy 会话）', async () => {
    const mock = installMocks()
    installLiveFetch()
    const { api } = withSpeech()
    await api.beginLive('m1')
    await new Promise((r) => setTimeout(r, 10))
    api.stop()
    expect(api.isLive()).toBe(false)
    expect(mock.audios[0].src).toBe('') // removeAttribute('src') = 真的断流
  })
})

/**
 * 自适应码率（2026-10-21）。
 *
 * 真实约束：96k = 12KB/s，实测弱网（手机热点出口 13KB/s）缓冲必见底；48k 只需 6KB/s。
 * 这里钉三件事：默认 96k、播起来后断粮立刻降 48k 并持久化、连续 3 轮干净再升回 96k。
 */
describe('useSpeech 会话流自适应码率', () => {
  const TOKEN = 'b'.repeat(48)
  let bodies: any[] = []

  function installFetch() {
    bodies = []
    globalThis.fetch = vi.fn(async (u: any, init?: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      if (String(u) === '/api/tts/live') {
        bodies.push(body)
        return { ok: true, json: async () => ({ token: TOKEN, url: `/api/tts/live/stream?t=${TOKEN}` }) } as any
      }
      return { ok: true, json: async () => ({ ok: true }) } as any
    }) as any
  }

  beforeEach(() => { try { localStorage.clear() } catch { /* jsdom 无 localStorage 时忽略 */ } })

  it('默认按 96 档开会话', async () => {
    installMocks(); installFetch()
    const { api } = withSpeech()
    await api.beginLive('m1')
    expect(bodies[0]?.quality).toBe('96')
  })

  it('播起来之后断粮（waiting/stalled）→ 下一轮降到 48 并写进 localStorage', async () => {
    const mock = installMocks(); installFetch()
    const { api } = withSpeech()
    await api.beginLive('m1')
    await new Promise((r) => setTimeout(r, 10))

    mock.audios[0].onplaying?.()      // 先真的出声
    mock.audios[0].onwaiting?.()      // 然后断粮
    api.stop()

    await api.beginLive('m2')         // 下一轮
    expect(bodies[bodies.length - 1]?.quality).toBe('48')
    expect(localStorage.getItem('supercrzy:ttsQuality')).toBe('48')
  })

  it('首次加载阶段的 waiting 不算断粮（不误降档）', async () => {
    const mock = installMocks(); installFetch()
    const { api } = withSpeech()
    await api.beginLive('m1')
    await new Promise((r) => setTimeout(r, 10))
    mock.audios[0].onwaiting?.()      // 还没 playing 过
    api.stop()
    await api.beginLive('m2')
    expect(bodies[bodies.length - 1]?.quality).toBe('96')
  })

  it('48 档连续 3 轮无断粮 → 自动升回 96', async () => {
    installMocks(); installFetch()
    try { localStorage.setItem('supercrzy:ttsQuality', '48') } catch {}
    const { api } = withSpeech()
    for (let i = 0; i < 3; i++) {
      const mock = installMocks(); installFetch()
      const a = await api.beginLive(`m${i}`)
      expect(a).toBe(true)
      await new Promise((r) => setTimeout(r, 5))
      mock.audios[mock.audios.length - 1].onplaying?.()
      mock.audios[mock.audios.length - 1].onended?.()
      await new Promise((r) => setTimeout(r, 5))
    }
    // 第 3 轮 ended 之后升回 96 —— 下一次开会话应当是 96
    installMocks(); installFetch()
    await api.beginLive('mX')
    expect(bodies[bodies.length - 1]?.quality).toBe('96')
  })
})

/**
 * 首声延迟的测量（2026-10-21）。
 *
 * 这条决定了自适应切块有没有「真数据」可用：测错 → 门槛算错 → 要么白等、要么断粮。
 * 时机的定义是「调 beginLive 那一刻 → 第一次 onplaying」，而不是「换到票」或「请求返回」。
 */
describe('useSpeech 首声延迟测量', () => {
  it('记录 beginLive → onplaying 的耗时并持久化（供阈值计算）', async () => {
    try { localStorage.clear() } catch {}
    const mock = installMocks()
    globalThis.fetch = vi.fn(async (u: any) => {
      if (String(u) === '/api/tts/live') {
        return { ok: true, json: async () => ({ token: 'c'.repeat(48), url: '/api/tts/live/stream?t=x' }) } as any
      }
      return { ok: true, json: async () => ({ ok: true }) } as any
    }) as any
    const { api } = withSpeech()
    expect(api.latencyMs()).toBe(1200) // 冷启动兜底值
    await api.beginLive('m1')
    await new Promise((r) => setTimeout(r, 30))
    mock.audios[0].onplaying?.()
    const v = api.latencyMs()
    expect(v).toBeGreaterThanOrEqual(200)   // 夹在合理区间
    expect(v).toBeLessThanOrEqual(5000)
    expect(Number(localStorage.getItem('supercrzy:ttsLatencyMs'))).toBe(v)
  })
})
