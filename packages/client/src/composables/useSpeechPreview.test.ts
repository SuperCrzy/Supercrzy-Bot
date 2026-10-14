// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { useSpeechPreview, formatTtsRate, PREVIEW_MAX_ATTEMPTS, PREVIEW_RETRY_BACKOFF_MS } from './useSpeechPreview'

/**
 * useSpeechPreview 单测
 *
 * 重点不在"请求发出去了"，而在**状态机与竞态**：
 * 预览失败必须复位（否则下拉里的按钮永远显示"停止"，用户以为在播）、
 * 请求还没回来就换音色/点停止时，**过期的音频不能再出声**。
 */

interface Audios { list: any[] }

function installMocks(opts: { fetchOk?: boolean; failFirstN?: number; blobEmpty?: boolean; playRejects?: boolean; delayMs?: number } = {}) {
  const calls = { fetch: 0, play: 0, pause: 0, revoke: 0, create: 0 }
  const audios: any[] = []
  const payloads: any[] = []

  globalThis.fetch = vi.fn(async (_url: string, init: any) => {
    calls.fetch++
    try { payloads.push(JSON.parse(init?.body || '{}')) } catch { /* noop */ }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
    const shouldFail = opts.fetchOk === false || calls.fetch <= (opts.failFirstN ?? 0)
    if (shouldFail) return { ok: false, status: 502, json: async () => ({ error: 'read ECONNRESET' }) } as any
    return {
      ok: true,
      status: 200,
      blob: async () => (opts.blobEmpty ? new Blob([]) : new Blob(['mp3'])),
    } as any
  }) as any

  class FakeAudio {
    src: string
    onended: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(url: string) { this.src = url; audios.push(this) }
    play() {
      calls.play++
      return opts.playRejects ? Promise.reject(new Error('autoplay blocked')) : Promise.resolve()
    }
    pause() { calls.pause++ }
  }
  ;(globalThis as any).Audio = FakeAudio
  ;(globalThis as any).URL.createObjectURL = () => { calls.create++; return 'blob:preview-' + calls.create }
  ;(globalThis as any).URL.revokeObjectURL = () => { calls.revoke++ }

  return { calls, audios, payloads }
}

function withPreview() {
  const scope = effectScope()
  const api = scope.run(() => useSpeechPreview())!
  return { api, dispose: () => scope.stop() }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

describe('formatTtsRate 语速串格式化（设置页试听与聊天朗读共用）', () => {
  it('0 / 空 / 非数字 → default', () => {
    expect(formatTtsRate(0)).toBe('default')
    expect(formatTtsRate(undefined)).toBe('default')
    expect(formatTtsRate(null)).toBe('default')
    expect(formatTtsRate(NaN)).toBe('default')
  })
  it('正负号必须显式带上（Edge TTS 要求 "+N%" 形式）', () => {
    expect(formatTtsRate(30)).toBe('+30%')
    expect(formatTtsRate(-20)).toBe('-20%')
    expect(formatTtsRate(10)).toBe('+10%')
  })
})

describe('useSpeechPreview', () => {
  let mock: ReturnType<typeof installMocks>
  beforeEach(() => { mock = installMocks() })

  it('点试听：请求 /api/tts（带指定音色与台词）→ 播放 → previewingId 置位', async () => {
    const { api } = withPreview()
    const ok = await api.preview('zh-CN-XiaoyiNeural', '您好，我是晓伊。', { voice: 'zh-CN-XiaoyiNeural', rate: '+20%' })
    expect(ok).toBe(true)
    expect(mock.calls.fetch).toBe(1)
    expect(mock.payloads[0]).toEqual({ text: '您好，我是晓伊。', voice: 'zh-CN-XiaoyiNeural', rate: '+20%' })
    expect(mock.calls.play).toBe(1)
    expect(api.previewingId.value).toBe('zh-CN-XiaoyiNeural')
  })

  it('播完自动复位（按钮回到播放图标）', async () => {
    const { api } = withPreview()
    await api.preview('id', '台词')
    mock.audios[0].onended()
    expect(api.previewingId.value).toBe(null)
  })

  it('播放出错也复位（不能让按钮卡在"正在播放"）', async () => {
    const { api } = withPreview()
    await api.preview('id', '台词')
    mock.audios[0].onerror()
    expect(api.previewingId.value).toBe(null)
  })

  it('后端失败 → 返回 false 且状态复位（调用方据此提示用户）', async () => {
    mock = installMocks({ fetchOk: false })
    const { api } = withPreview()
    const ok = await api.preview('id', '台词')
    expect(ok).toBe(false)
    expect(api.previewingId.value).toBe(null)
    expect(mock.audios.length).toBe(0)
  })

  it('空音频体 → 返回 false（不算试听成功）', async () => {
    mock = installMocks({ blobEmpty: true })
    const { api } = withPreview()
    expect(await api.preview('id', '台词')).toBe(false)
    expect(api.previewingId.value).toBe(null)
  })

  it('空台词不发请求（连后端都不打）', async () => {
    const { api } = withPreview()
    expect(await api.preview('id', '   ')).toBe(false)
    expect(mock.calls.fetch).toBe(0)
  })

  it('竞态：请求未回又点了另一个音色 → 旧结果丢弃，只播最新的', async () => {
    mock = installMocks({ delayMs: 30 })
    const { api } = withPreview()
    const p1 = api.preview('voiceA', 'A 的台词')
    const p2 = api.preview('voiceB', 'B 的台词')
    const [r1, r2] = await Promise.all([p1, p2])
    await tick(30)
    expect(r1).toBe(false) // 过期的那条不上屏
    expect(r2).toBe(true)
    expect(api.previewingId.value).toBe('voiceB')
    expect(mock.audios.length).toBe(1) // 只创建了一个音频实例
    expect(mock.audios[0].src).toBe('blob:preview-2') // 且是后点的那条
    expect(mock.calls.revoke).toBeGreaterThan(0) // 过期 URL 必须被释放（防泄漏）
  })

  it('竞态：请求未回就 stop → 不出声、状态为空', async () => {
    mock = installMocks({ delayMs: 30 })
    const { api } = withPreview()
    const p = api.preview('voiceA', '台词')
    api.stop()
    expect(await p).toBe(false)
    await tick(30)
    expect(mock.audios.length).toBe(0)
    expect(api.previewingId.value).toBe(null)
  })

  it('stop 会暂停在播的音频并复位', async () => {
    const { api } = withPreview()
    await api.preview('id', '台词')
    api.stop()
    expect(mock.calls.pause).toBe(1)
    expect(api.previewingId.value).toBe(null)
  })

  it('自动播放被浏览器拦截（play reject）→ 返回 false 且复位，不留假"播放中"', async () => {
    mock = installMocks({ playRejects: true })
    const { api } = withPreview()
    expect(await api.preview('id', '台词')).toBe(false)
    expect(api.previewingId.value).toBe(null)
  })
})

/**
 * 试听失败重试（2026-09-28 加）。
 *
 * 背景：老板报"设置页试听显示服务不可用"。真因是上游 `speech.platform.bing.com` 握手
 * 约 3/4 次数被 RST —— 单次请求成功率仅 ~20%。试听是**点一下就该出声**的一次性动作，
 * 点一次就报"不可用"是最糟的反馈，所以这一层也要重试。
 */
describe('useSpeechPreview 失败重试', () => {
  let mock: ReturnType<typeof installMocks>

  it('首次失败 → 重试后成功（用户根本不知道中间抖了一下）', async () => {
    mock = installMocks({ failFirstN: 1 })
    const { api } = withPreview()
    expect(await api.preview('id', '台词')).toBe(true)
    expect(mock.calls.fetch).toBe(2)
    expect(mock.calls.play).toBe(1)
  })

  it('一直失败 → 打满上限才放弃（而不是点一次就报错）', async () => {
    mock = installMocks({ fetchOk: false })
    const { api } = withPreview()
    expect(await api.preview('id', '台词')).toBe(false)
    expect(mock.calls.fetch).toBe(PREVIEW_MAX_ATTEMPTS)
    expect(api.previewingId.value).toBe(null)
    expect(mock.audios.length).toBe(0)
  })

  it('**播放**失败不重试（自动播放被拦时重取音频毫无意义，白等 1 秒）', async () => {
    mock = installMocks({ playRejects: true })
    const { api } = withPreview()
    expect(await api.preview('id', '台词')).toBe(false)
    expect(mock.calls.fetch).toBe(1)
  })

  it('重试期间状态保持"正在试听"（按钮显示停止，不是闪回播放）', async () => {
    mock = installMocks({ failFirstN: 1 })
    const { api } = withPreview()
    const p = api.preview('voiceA', '台词')
    expect(api.previewingId.value).toBe('voiceA')
    await p
    expect(api.previewingId.value).toBe('voiceA') // 播放中仍是它
  })

  it('重试期间用户点了停止 → 立刻放弃，不再发后续请求', async () => {
    mock = installMocks({ fetchOk: false })
    const { api } = withPreview()
    const p = api.preview('id', '台词')
    api.stop()
    expect(await p).toBe(false)
    expect(mock.calls.fetch).toBeLessThan(PREVIEW_MAX_ATTEMPTS)
  })

  it('退避表不变量（长度与尝试次数强耦合、且递增）', () => {
    expect(PREVIEW_RETRY_BACKOFF_MS.length).toBe(PREVIEW_MAX_ATTEMPTS - 1)
    for (let i = 1; i < PREVIEW_RETRY_BACKOFF_MS.length; i++) {
      expect(PREVIEW_RETRY_BACKOFF_MS[i]).toBeGreaterThan(PREVIEW_RETRY_BACKOFF_MS[i - 1])
    }
  })
})
