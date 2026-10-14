/**
 * 完成提示音 — Web Audio API 本地合成
 *
 * 设计要点：
 * - **音效注册表**：每款音效 = 一组「频率 / 起始偏移 / 时长」+ 波形，全是参数，
 *   不依赖任何音频资源文件（零下载、零延迟、离线可用、Web 与 Electron 完全一致）。
 * - **音色可选**：SOUND_TONES 的 id 存进 settings（completionSoundTone）。
 * - **音量可调**：0.05~0.4（completionSoundVolume），即原来写死的 0.15 换成入参。
 * - **试听与真实播放同一条代码路径**：previewCompletionTone 就是带参调用，
 *   不存在「试听好听、真响不一样」的偏差。
 *
 * 本模块是纯 util（不引 store）：音色/音量由调用方从 appStore 传入，
 * 缺省回落到经典双音 + 默认音量，保证老调用点 `playCompletionSound()` 行为不变。
 */

export type CompletionToneId = 'classic' | 'single' | 'chord' | 'down'

interface ToneNote {
  /** 频率（Hz） */
  freq: number
  /** 相对起始点的偏移（秒） */
  at: number
  /** 单音持续（秒），同用作指数衰减时长 */
  dur: number
}

interface ToneDef {
  id: CompletionToneId
  /** 振荡器波形 */
  type: OscillatorType
  notes: ToneNote[]
}

/**
 * 内置音效（顺序即设置页下拉顺序）
 * classic = 历史默认音（C5→E5 上升双音），参数与旧实现逐字对齐 —— 老用户听感零变化
 */
export const SOUND_TONES: ToneDef[] = [
  {
    id: 'classic',
    type: 'sine',
    notes: [
      { freq: 523, at: 0, dur: 0.2 },
      { freq: 659, at: 0.15, dur: 0.3 },
    ],
  },
  // 单音轻响：A5 一记短点，最安静
  {
    id: 'single',
    type: 'sine',
    notes: [{ freq: 880, at: 0, dur: 0.18 }],
  },
  // 柔和琶音：C5→E5→G5，三角波更亮，完成感最强
  {
    id: 'chord',
    type: 'triangle',
    notes: [
      { freq: 523, at: 0, dur: 0.34 },
      { freq: 659, at: 0.07, dur: 0.34 },
      { freq: 784, at: 0.14, dur: 0.4 },
    ],
  },
  // 下降双音：E5→C5，用于「告一段落」
  {
    id: 'down',
    type: 'sine',
    notes: [
      { freq: 659, at: 0, dur: 0.2 },
      { freq: 523, at: 0.16, dur: 0.32 },
    ],
  },
]

export const DEFAULT_TONE: CompletionToneId = 'classic'
export const DEFAULT_VOLUME = 0.15
export const MIN_VOLUME = 0.05
export const MAX_VOLUME = 0.4

/** 音色 id 白名单归一（脏数据/旧值一律回落 classic） */
export function normalizeTone(v: unknown): CompletionToneId {
  return SOUND_TONES.some((t) => t.id === v) ? (v as CompletionToneId) : DEFAULT_TONE
}

/** 音量归一：非数字回落默认；夹到 [MIN_VOLUME, MAX_VOLUME]（下限 >0，指数衰减不允许 0 起点） */
export function normalizeVolume(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return DEFAULT_VOLUME
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, n))
}

let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)()
  }
  return audioCtx
}

/**
 * 播放指定音效（试听与真实播放共用）
 * @param toneId 音色 id，非法值回落经典双音；缺省 = classic
 * @param volume 峰值增益，缺省 = 0.15
 *
 * 只有在用户交互后才能播放（浏览器 autoplay 政策）；失败一律静默，不影响用户体验。
 */
export function playCompletionTone(toneId?: string | null, volume?: number | null): void {
  try {
    const def = SOUND_TONES.find((t) => t.id === normalizeTone(toneId)) ?? SOUND_TONES[0]
    const vol = volume === undefined || volume === null ? DEFAULT_VOLUME : normalizeVolume(volume)
    const ctx = getAudioContext()
    if (ctx.state === 'suspended') {
      ctx.resume()
    }

    const now = ctx.currentTime
    for (const note of def.notes) {
      const at = now + note.at
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = def.type
      osc.frequency.setValueAtTime(note.freq, at)
      gain.gain.setValueAtTime(vol, at)
      gain.gain.exponentialRampToValueAtTime(0.001, at + note.dur)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(at)
      osc.stop(at + note.dur)
    }
  } catch {
    // 静默失败
  }
}

/** 试听别名 —— 语义清晰，实现与真实播放完全相同 */
export function previewCompletionTone(toneId?: string | null, volume?: number | null): void {
  playCompletionTone(toneId, volume)
}

/**
 * 兼容入口：无参调用 = 经典双音 + 默认音量
 * （历史调用点行为保持不变）
 */
export function playCompletionSound(): void {
  playCompletionTone()
}
