/**
 * useSpeechPreview — 设置页「试听」用的一次性语音预览（Edge TTS 单句，2026-09-27）。
 *
 * 与 `useSpeech`（朗读整条 AI 回复）分工不同，别合并：
 *  - 预览只需**一次请求、播完即止**：没有分句队列、没有预取、没有暂停/续读
 *  - 预览**必须能指定音色** —— 试听的就是"这个音色"，所以不能用 useSpeech 的 options.voice getter
 *  - 预览**不做 Lite 回落**：拿系统 TTS 音色冒充"晓晓"是误导用户，失败就如实返回 false 让调用方提示
 *  - 预览**失败要重试**（2026-09-28 加）：上游 `speech.platform.bing.com` 的握手实测约
 *    3/4 次数被 RST，单次成功率仅 ~20%。试听是"用户点一下"的一次性动作，
 *    点一次就报"服务不可用"是最糟的反馈 —— 服务端已重试 3 次，这里再兜 3 次。
 *
 * 全局单例语义：同一时刻只允许一条预览在响（预览新的自动停旧的）。
 */
import { ref, onBeforeUnmount } from 'vue'

/** 试听最多请求几次（含首次）。与服务端自己的 3 次重试叠加，单次点击成功率约 85~95% */
export const PREVIEW_MAX_ATTEMPTS = 3
/** 每次重试前的退避（ms），长度必须 = PREVIEW_MAX_ATTEMPTS - 1 */
export const PREVIEW_RETRY_BACKOFF_MS = [300, 800] as const

/**
 * 语速（-50~50 的百分数）→ Edge TTS 的 rate 串。
 * 单一来源：设置页试听与聊天朗读都用它，避免两处格式化分叉。
 */
export function formatTtsRate(rate: number | undefined | null): string {
  const v = Number(rate) || 0
  return v === 0 ? 'default' : `${v > 0 ? '+' : ''}${v}%`
}

export function useSpeechPreview() {
  /** 正在试听的音色/音效 id（null = 没有在试听）；UI 据此把播放按钮切成停止 */
  const previewingId = ref<string | null>(null)

  let token = 0 // 防竞态：每次 preview/stop 自增，异步回来时比对，过期结果直接丢弃
  let audio: HTMLAudioElement | null = null
  let url: string | null = null

  function cleanup() {
    if (audio) {
      audio.onended = null
      audio.onerror = null
      try { audio.pause() } catch { /* noop */ }
      audio = null
    }
    if (url) {
      try { URL.revokeObjectURL(url) } catch { /* noop */ }
      url = null
    }
  }

  /** 停止当前预览（含丢弃"还在请求中"的那条） */
  function stop() {
    token += 1
    cleanup()
    previewingId.value = null
  }

  /**
   * 试听指定台词。返回是否成功（失败时状态已复位，调用方可直接提示）。
   * @param id   用于 UI 的标识（音色 id / 音效 id）
   * @param text 台词（音色试听用后端下发的 sample）
   */
  async function preview(
    id: string,
    text: string,
    opts: { voice?: string; rate?: string } = {},
  ): Promise<boolean> {
    stop()
    const my = token
    if (!text || !text.trim()) return false

    previewingId.value = id

    // ① 取音频：这一层**可重试**（上游握手被 RST 是常态）
    let objectUrl: string | null = null
    for (let attempt = 1; attempt <= PREVIEW_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: opts.voice, rate: opts.rate }),
        })
        if (!res.ok) {
          let msg = `HTTP ${res.status}`
          try {
            const j = await res.json()
            if (j?.error) msg = String(j.error)
          } catch { /* 非 JSON 错误体 */ }
          throw new Error(msg)
        }
        const blob = await res.blob()
        if (!blob.size) throw new Error('音频为空')
        objectUrl = URL.createObjectURL(blob)
        break
      } catch {
        // 用户中途换了音色 / 点了停止 → 立刻放弃，别把重试拖到用户已经不看的时候
        if (my !== token) {
          previewingId.value = null
          return false
        }
        if (attempt >= PREVIEW_MAX_ATTEMPTS) {
          cleanup()
          previewingId.value = null
          return false
        }
        await new Promise((r) => setTimeout(r, PREVIEW_RETRY_BACKOFF_MS[attempt - 1] ?? 800))
        if (my !== token) {
          previewingId.value = null
          return false
        }
      }
    }
    if (!objectUrl) {
      cleanup()
      previewingId.value = null
      return false
    }

    // 请求期间用户又试听了别的 / 点了停止 → 丢弃，别出声
    if (my !== token) {
      URL.revokeObjectURL(objectUrl)
      return false
    }

    // ② 播放：**不重试** —— 自动播放被拦 / 解码失败，重取一遍也是同样结果
    const a = new Audio(objectUrl)
    url = objectUrl
    audio = a
    const done = () => {
      if (my !== token) return
      cleanup()
      previewingId.value = null
    }
    a.onended = done
    a.onerror = done
    try {
      await a.play()
    } catch {
      done()
      return false
    }
    return true
  }

  onBeforeUnmount(stop)

  return { previewingId, preview, stop }
}
