/**
 * 聊天朗读编排 —— 「什么时候读、读什么」的判定全在这里（2026-09-28 从 ChatView 抽出）。
 *
 * 为什么必须抽出来：ChatView.vue 顶在巨石闸门（5500 行）上，「边生成边朗读」要在
 * `content_chunk` 上接一行，**加不进去**。抽完之后 ChatView 只剩接线，
 * 判定逻辑集中于此且可单测（不依赖组件挂载）。
 *
 * 三条路径：
 *   · 手动点朗读按钮 → `toggleSpeak`（同一条消息：播 → 暂停 → 继续；换消息则重读）
 *   · 一轮成功结束 → `turnEnd`（完成提示音由调用方负责，这里只判"要不要读、读什么"）
 *   · 正文流式到达 → `feedStream`（可选，按设置的开关走；边生成边读）
 *
 * 🔴 两处最容易写错的地方，都在这里有明确约束：
 *   ① **绝不能重复朗读** —— 本轮已经边生成边读过，`turnEnd` 就直接返回；
 *      失败轮次已经念出去的部分也**不再整条重读**（`resetStream` + `stop`）。
 *   ② **流式和整条是互斥的两条路** —— 流式只在"本轮本来就会自动读"的前提下开，
 *      判定复用 `shouldAutoRead`（off = 不读；background = 仅窗口不在前台时读）。
 */
import { onBeforeUnmount, ref } from 'vue'
import type { ChatMessage } from '@/types'
import { useSpeech } from '@/composables/useSpeech'
import {
  STREAM_BUFFER_HARD_MAX,
  STREAM_FIRST_MIN_CHARS,
  STREAM_MAX_CHARS,
  ensureSentenceEnd,
  extractSpeakText,
  finishLiveChunk,
  markdownToSpeech,
  packForTts,
  takeLiveChunk,
  takeStreamChunk,
} from '@/utils/speech-text'
import { isWindowForeground, shouldAutoRead } from '@/utils/auto-read'

export interface UseChatSpeechOptions {
  /** 音色（Pro 档）：返回 Edge TTS voice id */
  voice?: () => string | undefined
  /** 语速（Pro 档）：返回 Edge TTS rate 串 */
  rate?: () => string | undefined
  /** 自动朗读档位（读设置：off / background / always） */
  mode?: () => unknown
  /** 是否开启「边生成边朗读」（读设置） */
  streamRead?: () => boolean
  /**
   * 是否走**会话式朗读**（一条消息一条流，2026-10-21）。
   *
   * 默认关闭是刻意的：这是"另一条路"，不是开关；调用方不传就完全保持旧行为，
   * 单测与老客户端都不受影响。开启后行为见 feedStream 的 live 分支。
   */
  live?: () => boolean
  /** 窗口是否在前台（默认 isWindowForeground；测试可注入） */
  foreground?: () => boolean
  /** Look up a message by id (used by resume: the UI only holds the msgId, the text lives in the
   *  message) */
  getMessage?: (id: string) => ChatMessage | undefined
}

/**
 * Minimum buffered chars before opening a session. This only decides *when to open the session*,
 * never how to split — splitting is controlled by `takeLiveChunk`'s three-level first-chunk rule.
 * 16 chars ≈ one sentence; for very short replies (a few chars) reading the whole thing at turnEnd
 * sounds better (saves a session round trip).
 */
export const LIVE_START_MIN_CHARS = 16

export function useChatSpeech(options: UseChatSpeechOptions = {}) {
  const speech = useSpeech({ voice: options.voice, rate: options.rate })
  const foreground = options.foreground || isWindowForeground

  // ---- 流式状态（一轮一组，turnEnd 或换消息时清空）----
  let streamMsgId: string | null = null
  let streamBuf = ''
  /** 本轮是否**已经**开始边生成边读（用于 turnEnd 判"要不要再整条读"） */
  let streamOn = false
  /** 本轮是否已放弃流式（Pro 冷却 / 缓冲超限）→ 后续 chunk 直接丢，交给 turnEnd 整条读 */
  let streamGaveUp = false
  /** 本轮是否已送出过块 —— 后续块的门槛要抬高（见 drainStream） */
  let streamEmitted = false

  // ---- 会话流状态（2026-10-21，一条消息一条流）----
  /** 会话已开（audio 已指向 /api/tts/live/stream） */
  let liveOn = false
  /** 正在异步开会话，期间的 chunk 先攒在 streamBuf 里 */
  let liveStarting = false
  /** 开会话的在途 promise（极短回复时 turnEnd 要等它开好再补推残余） */
  let liveStartPromise: Promise<boolean> | null = null
  /** Whether the first chunk has been pushed (decides first-chunk three-level rule vs seconds rule) */
  let livePushed = false
  /** Chars of cleaned text acknowledged as pushed this turn (tracked separately from
   *  speech.livePushedChars: this one includes the flush) */
  let livePushedClean = 0
  /** **Start** offset of the last push (cleaned-text offset) — resume looks for a sentence end
   *  after this point, so it never starts mid-word */
  let liveLastStart = 0

  /** Reading interruption (reactive, for the speak bar UI): set on a push failure / audio stall /
   *  dropped tail */
  const interrupted = ref<{ msgId: string; resumeFrom: number } | null>(null)

  function resetStream() {
    streamMsgId = null
    streamBuf = ''
    streamOn = false
    streamGaveUp = false
    streamEmitted = false
    liveOn = false
    liveStarting = false
    liveStartPromise = null
    livePushed = false
    livePushedClean = 0
    liveLastStart = 0
  }

  /** 本轮现在是否"本来就会读"（与 turnEnd 同一套判定，ok/hasText 先按成立预判） */
  function readsThisTurn(): boolean {
    return shouldAutoRead({ mode: options.mode?.(), ok: true, hasText: true, foreground: foreground() })
  }

  /**
   * 把缓冲里所有够格的块送出去（一次到达多个块时循环切完）。
   *
   * **门槛是两级的**，这是"尽量少切"的关键：
   *   · 首块用 `STREAM_FIRST_MIN_CHARS`（200）—— 唯一目标是**尽快出声**
   *   · 后续块用 `STREAM_MAX_CHARS`（600）—— 此时音频已经在播，块越大越好：
   *     每块 ≈130s 音频 vs ≈1.6s 合成，块间不可能缺料，而**请求数越少上游越稳**
   *     （同一个"少切"结论：上游握手约 3/4 次数被 RST，次数就是暴露面）
   * 早先统一用 200 的实现会让一条 900 字回复切成 4~5 次请求 —— 每句一过门槛就切，
   * 等于又回到"把固定成本付 N 次"的老路。
   */
  function drainStream() {
    for (;;) {
      const min = streamEmitted ? STREAM_MAX_CHARS : STREAM_FIRST_MIN_CHARS
      const cut = takeStreamChunk(streamBuf, min)
      if (!cut) return
      streamBuf = cut.rest
      // 先清洗 markdown 再补句末标点：清洗会去掉尾部的表格/符号残留，
      // 补标点必须发生在清洗之后，否则补出来的句号可能被一起洗掉。
      const text = ensureSentenceEnd(markdownToSpeech(cut.chunk))
      if (text) {
        speech.appendStreamText(text)
        streamEmitted = true
      }
    }
  }

  // ===== 会话式（一条消息一条流，2026-10-21）=====

  /** 本轮是否走会话流（调用方没传 = 关闭，保持旧行为） */
  function liveEnabled(): boolean {
    return options.live?.() === true
  }

  /**
   * Push buffered text into the live stream (rewritten: driven by **unplayed seconds**, no more
   * char-count batching).
   *
   * The old mechanism (fixed 40~120 char thresholds) was rejected by three experiments: 65% of
   * English cut points landed mid-sentence; a fixed char count starved for 46.6s under slow
   * generation; and it produced 4x more seams than the seconds strategy.
   * New mechanism:
   *   · First chunk: `takeLiveChunk` earliest-of-three (first sentence / comma after 30 chars /
   *     60-char fallback) — first sound ASAP
   *   · Following: unplayed >= 6s → don't cut (merge, fewer seams); < 6s → push everything that
   *     is already a full sentence; only below 3s do a mid-sentence rescue cut
   */
  function drainLive() {
    for (;;) {
      const cut = takeLiveChunk(streamBuf, {
        first: !livePushed,
        bufferedAheadSec: liveOn ? speech.liveAheadSec() : 0,
      })
      if (!cut) return
      // Line boundary must be checked **before** cleanup (markdownToSpeech eats newlines) —
      // a line end is a real pause, and finishLiveChunk uses it to decide about a terminator.
      const rawEndedAtLine = cut.chunk.endsWith('\n')
      streamBuf = cut.rest
      const text = finishLiveChunk(markdownToSpeech(cut.chunk), rawEndedAtLine)
      if (!text) continue
      liveLastStart = livePushedClean
      livePushedClean += text.length
      speech.pushLive(text)
      livePushed = true
    }
  }

  /** 开会话；失败就把本轮让回给 turnEnd 的整条读（不硬撑） */
  function startLive(msg: ChatMessage) {
    if (liveOn || liveStarting) return
    liveStarting = true
    const p = speech.beginLive(msg.id)
    liveStartPromise = p
    void p.then((ok) => {
      liveStarting = false
      if (!ok) {
        // 开会话失败（后端不可用 / Pro 冷却）→ 放弃流式，别每个 chunk 反复重试
        streamGaveUp = true
        streamBuf = ''
        return
      }
      liveOn = true
      drainLive()
    })
  }

  /**
   * Wrap up: push the remaining text, then **wait for the push queue to drain** before telling the
   * server there is nothing more.
   *
   * Returns `{ token, resumeFrom }`: token is for a later status query (did the server drop the
   * tail), resumeFrom is the start of the last push (the resume anchor, captured before
   * resetStream zeroes it).
   */
  async function flushLive(): Promise<{ token: string | null; resumeFrom: number }> {
    if (streamBuf) {
      for (const pack of packForTts(markdownToSpeech(streamBuf))) {
        liveLastStart = livePushedClean
        livePushedClean += pack.length
        speech.pushLive(pack)
      }
      streamBuf = ''
    }
    const token = speech.liveTokenNow()
    await speech.endLive()
    return { token, resumeFrom: liveLastStart }
  }

  /**
   * 正文增量到达 —— **流式朗读唯一的入口**（ChatView 只调这一个函数）。
   *
   * 开读时机不是"第一个 chunk 到达"，而是"**攒够一块**且本轮本来就会读"：
   * 短回复（<200 字）根本攒不出块，直接等 turnEnd 整条读反而更好听（1 次请求）。
   * 另外这样也不必每 chunk 都查一次 `hasFocus()`。
   */
  function feedStream(msg: ChatMessage, chunk: string) {
    if (!chunk) return
    if (streamMsgId !== msg.id) {
      resetStream()
      streamMsgId = msg.id
    }
    if (streamGaveUp) return
    streamBuf += chunk

    if (!streamOn && !liveOn && !liveStarting) {
      // 兜底：条件长期不成立（如一直在前台 + background 档）时别无限攒字符串
      if (streamBuf.length > STREAM_BUFFER_HARD_MAX) {
        streamGaveUp = true
        streamBuf = ''
        return
      }
      const live = liveEnabled()
      // Live mode: open the session at 16 chars (splitting is handled by takeLiveChunk's
      // first-chunk rule); per-chunk streaming keeps its 60-char threshold
      const firstMin = live ? LIVE_START_MIN_CHARS : STREAM_FIRST_MIN_CHARS
      if (streamBuf.length < firstMin) return
      if (!options.streamRead?.() || !readsThisTurn()) return
      if (live) { startLive(msg); return } // 异步开会话，期间的 chunk 继续攒在 streamBuf
      if (!speech.beginStream(msg.id)) {
        // Pro 冷却中 → 本轮只能走 Lite，而系统 TTS 没有增量能力
        streamGaveUp = true
        streamBuf = ''
        return
      }
      streamOn = true
    }
    if (liveOn) { drainLive(); return }
    if (liveStarting) return
    drainStream()
  }

  /** 流结束：残余缓冲按整条打包发完（此时已无接缝问题），再收尾 */
  function flushStream() {
    if (!streamOn) {
      streamBuf = ''
      return
    }
    if (streamBuf) {
      for (const pack of packForTts(markdownToSpeech(streamBuf))) speech.appendStreamText(pack)
      streamBuf = ''
    }
    speech.endStream()
  }

  /**
   * Decide "was this turn interrupted?" after the live stream wrapped up. Two failure signals:
   *   1. Push failure (useSpeech.liveFailed: non-ok push / audio stall)
   *   2. Server-side synthesis turn failure (`status.failed` — the audio "ends normally" but only
   *      holds half the content, which is invisible locally, so the server must be asked; an older
   *      backend without this endpoint returns null and only signal 1 applies)
   * A hit sets `interrupted`, which makes the speak bar show the "Resume" button.
   */
  function checkLiveInterrupted(
    msg: ChatMessage,
    token: string | null,
    resumeFrom: number,
  ): void {
    let failed = speech.liveFailed.value
    if (token && !failed) {
      // Query status once: liveFailed may have been overwritten when the audio ended naturally,
      // and the server's failed flag is the only reliable evidence of a dropped tail
      void (async () => {
        let statusFailed: boolean | null = null
        try {
          const res = await fetch(`/api/tts/live/status?t=${encodeURIComponent(token)}`)
          if (res.ok) {
            const j: any = await res.json().catch(() => null)
            statusFailed = j?.failed === true
          }
        } catch { /* network failure: keep the local verdict */ }
        if (statusFailed === true) {
          interrupted.value = { msgId: msg.id, resumeFrom }
        }
      })()
    }
    if (failed) interrupted.value = { msgId: msg.id, resumeFrom }
  }

  /**
   * Resume an interrupted reading (what the speak bar's "Resume" button hits):
   * start from the first sentence end after the last push's **start offset** — anchoring on the
   * start guarantees it never opens mid-word; the cost is at most half a sentence repeated
   * (repeat rather than lose content, the same principle as failPro).
   *
   * Accepts a msgId (the UI only holds the id) or a message object; the lookup goes through
   * options.getMessage so ChatView does not need another "find message by id" helper (it is right
   * at the file-size limit).
   */
  function resumeInterrupted(msgOrId: ChatMessage | string) {
    const it = interrupted.value
    interrupted.value = null
    if (!it) return
    const msg = typeof msgOrId === 'string' ? options.getMessage?.(msgOrId) : msgOrId
    if (!msg || it.msgId !== msg.id) return
    const full = extractSpeakText((msg as any).content)
    if (!full.trim()) return
    const from = Math.min(it.resumeFrom, full.length)
    const rest = full.slice(from)
    if (!rest.trim()) return
    // Opening mid-word sounds bad: skip to the first sentence end in rest (at most one sentence,
    // searched only within 300 chars)
    const m = rest.slice(0, 300).match(/^[^。！？!?…；;.!?\n]*[。！？!?…；;]\s*/)
    const text = m ? rest.slice(m[0].length) : rest
    if (text.trim()) speech.speak(msg.id, text)
  }

  /**
   * 本轮结束（三条路径的唯一出口）—— 只判朗读，不碰提示音。
   *
   * `ok === false`（失败 / 中断 / 用户手动停止）一律不出声：念半截答案或失败任务是负价值。
   * 若本轮已经边生成边读过，这里必须**停掉并清状态**，否则 `speakingId` 永远不归零、
   * 朗读按钮卡在"正在播放"。
   */
  function turnEnd(msg: ChatMessage, ok: boolean): void {
    const streamed = streamOn
    const live = liveOn || liveStarting
    let liveEndPromise: Promise<void> | null = null
    if (liveOn) {
      liveEndPromise = flushLive().then((r) => { checkLiveInterrupted(msg, r.token, r.resumeFrom) })
    } else if (liveStarting && liveStartPromise) {
      // 会话还没开好就结束了（极短回复）：等它开好再补推残余 + 收尾，
      // 否则这条回复一个字都不会读（比读得晚更糟）。
      const p = liveStartPromise
      liveEndPromise = p.then(async (startedOk) => {
        if (!startedOk) { speech.stop(); return }
        const r = await flushLive()
        checkLiveInterrupted(msg, r.token, r.resumeFrom)
      })
    }
    flushStream()
    resetStream()
    if (!ok) {
      if (streamed || live) speech.stop()
      return
    }
    // 已经边生成边读过了 → 绝不再整条重读一遍
    if (liveEndPromise) return
    if (streamed) return
    const text = extractSpeakText((msg as any).content)
    if (!shouldAutoRead({ mode: options.mode?.(), ok, hasText: !!text, foreground: foreground() })) return
    speech.speak(msg.id, text)
  }

  /**
   * 手动点朗读按钮 —— **单键语义**（2026-10-23）：点一下读、再点一下停，没有暂停态。
   * 中断（丢尾/失败）过的那条，点一下从断点续读，而不是从头再念一遍。
   *
   * 为什么去掉暂停：一个键承担「读/暂停/继续」三个语义时，长内容里用户分不清自己点的是
   * 暂停还是停止，而暂停态的收益（稍后接着听）可以由「停止后再点=续读」覆盖。
   */
  function toggleSpeak(msg: ChatMessage) {
    // 顺序有讲究：**先判中断**。中断时 speakingId 可能还没归零（音频错误与状态清理不同步），
    // 若先判"正在读这条"就会走进 stop 分支，把用户想要的续读吞掉。
    if (interrupted.value?.msgId === msg.id) {
      resumeInterrupted(msg)
      return
    }
    // 正在读这条 → 直接停（不进入暂停）
    if (speech.speakingId.value === msg.id) {
      stopSpeech()
      return
    }
    const text = extractSpeakText((msg as any).content)
    if (!text) return
    speech.speak(msg.id, text)
  }

  /** 停读（切会话 / 新一轮开始 / 手动停）—— 顺带丢弃流式状态，否则残块会串到下一轮 */
  function stopSpeech() {
    resetStream()
    // Manually stopping means the user does not want to resume — drop the interruption hint too
    interrupted.value = null
    speech.stop()
  }

  onBeforeUnmount(stopSpeech)

  return {
    supported: speech.supported,
    speakingId: speech.speakingId,
    paused: speech.paused,
    /** 处于「Pro 不可用，已回落系统音色」的降级态（UI 据此提示） */
    proDegraded: speech.proDegraded,
    /** 处于「已点朗读、但还一声没出」的合成窗口（UI 据此显示"正在合成语音"并禁用暂停） */
    synthesizing: speech.synthesizing,
    isPro: speech.isPro,
    /** Reading interruption (reactive): set on a push failure / audio stall / dropped tail; the
     *  speak bar shows "Resume" from it */
    interrupted,
    /** Resume an interrupted reading: continue from the first sentence end after the last push's
     *  start offset */
    resumeInterrupted,
    toggleSpeak,
    /** 流式：正文增量到达 */
    feedStream,
    /** 本轮结束的朗读出口（提示音由调用方另做） */
    turnEnd,
    stop: stopSpeech,
    /** 底层开关（朗读条上的暂停/继续按钮直接用） */
    toggle: speech.toggle,
  }
}
