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
import { onBeforeUnmount } from 'vue'
import type { ChatMessage } from '@/types'
import { useSpeech } from '@/composables/useSpeech'
import {
  STREAM_BUFFER_HARD_MAX,
  STREAM_FIRST_MIN_CHARS,
  STREAM_MAX_CHARS,
  ensureSentenceEnd,
  extractSpeakText,
  markdownToSpeech,
  packForTts,
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
  /** 窗口是否在前台（默认 isWindowForeground；测试可注入） */
  foreground?: () => boolean
}

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

  function resetStream() {
    streamMsgId = null
    streamBuf = ''
    streamOn = false
    streamGaveUp = false
    streamEmitted = false
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

    if (!streamOn) {
      // 兜底：条件长期不成立（如一直在前台 + background 档）时别无限攒字符串
      if (streamBuf.length > STREAM_BUFFER_HARD_MAX) {
        streamGaveUp = true
        streamBuf = ''
        return
      }
      if (streamBuf.length < STREAM_FIRST_MIN_CHARS) return
      if (!options.streamRead?.() || !readsThisTurn()) return
      if (!speech.beginStream(msg.id)) {
        // Pro 冷却中 → 本轮只能走 Lite，而系统 TTS 没有增量能力
        streamGaveUp = true
        streamBuf = ''
        return
      }
      streamOn = true
    }
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
   * 本轮结束（三条路径的唯一出口）—— 只判朗读，不碰提示音。
   *
   * `ok === false`（失败 / 中断 / 用户手动停止）一律不出声：念半截答案或失败任务是负价值。
   * 若本轮已经边生成边读过，这里必须**停掉并清状态**，否则 `speakingId` 永远不归零、
   * 朗读按钮卡在"正在播放"。
   */
  function turnEnd(msg: ChatMessage, ok: boolean): void {
    const streamed = streamOn
    flushStream()
    resetStream()
    if (!ok) {
      if (streamed) speech.stop()
      return
    }
    // 已经边生成边读过了 → 绝不再整条重读一遍
    if (streamed) return
    const text = extractSpeakText((msg as any).content)
    if (!shouldAutoRead({ mode: options.mode?.(), ok, hasText: !!text, foreground: foreground() })) return
    speech.speak(msg.id, text)
  }

  /** 手动点朗读按钮：同一条消息 播放 → 暂停 → 继续；换消息则重读 */
  function toggleSpeak(msg: ChatMessage) {
    if (speech.speakingId.value === msg.id) {
      speech.toggle(msg.id, '') // 已在读该条 → 暂停/继续（文本不用重算）
      return
    }
    const text = extractSpeakText((msg as any).content)
    if (!text) return
    speech.toggle(msg.id, text)
  }

  /** 停读（切会话 / 新一轮开始 / 手动停）—— 顺带丢弃流式状态，否则残块会串到下一轮 */
  function stopSpeech() {
    resetStream()
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
