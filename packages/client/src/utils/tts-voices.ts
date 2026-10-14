/**
 * 朗读音色下拉的选项整形（纯函数，无浏览器 API）。
 *
 * 为什么单独成文件：设置页的「点名字 → 自动试听」依赖**下拉每一项都带 sample 台词**。
 * 这条链路有两个沉默失败点，都只在真机上表现为「点了没反应 / 念错名字」，本地看不出来：
 *   ① 音色清单由后端下发，「sample」可能缺失（旧后端、或清单扩展时漏填）
 *   ② 后端不可用时用内置兜底清单，兜底项若没 sample → 点名字自动试听直接哑掉
 * 所以这里统一补台词，并用单测钉死「每项台词都提到自己的名字」
 * —— 台词里名字写错，真机上听起来只像"音色不对"，极难定位。
 *
 * 台词模板与后端 `services/tts.ts` 的 `TTS_VOICES[].sample` 保持同一形状：
 * 中文音色「您好，我是X，是你的 SUPERCRZY BOT.」（中英混读，品牌名不翻译）。
 */

/** 后端 `/api/tts/voices` 下发的一条音色 */
export interface TtsVoiceEntry {
  id: string
  label: string
  /** 试听台词；后端下发的为准，缺失时由本模块补兜底 */
  sample?: string
}

/** naive-ui 下拉选项（在 value/label 之外挂一个 sample 供试听用） */
export interface TtsVoiceOption {
  label: string
  value: string
  sample: string
}

/** 品牌名：中英混读时不翻译，故两种模板都带上 */
const BRAND = 'SUPERCRZY BOT'

/** label 形如「晓晓（女声·自然）」/「Aria（English）」→ 只取名字部分 */
export function voiceDisplayName(label: string): string {
  const raw = String(label ?? '')
  const name = raw.split(/[（(]/)[0].trim()
  return name || raw.trim()
}

/** 英文音色（label 不含中日韩文字）→ 用英文台词；否则中文台词 */
function isLatinLabel(label: string): boolean {
  const name = voiceDisplayName(label)
  return !!name && !/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(name)
}

/** 兜底台词：中文音色中文念、英文音色英文念（拿英文音色念中文自我介绍会很出戏） */
export function fallbackVoiceSample(label: string): string {
  const name = voiceDisplayName(label)
  return isLatinLabel(label)
    ? `Hi, I'm ${name}, your ${BRAND}.`
    : `您好，我是${name}，是你的 ${BRAND}.`
}

/** 清单 → 下拉选项：sample 缺失时补兜底（保证每一项都能试听） */
export function toVoiceOptions(voices: readonly TtsVoiceEntry[] | null | undefined): TtsVoiceOption[] {
  if (!Array.isArray(voices)) return []
  return voices
    .filter((v) => v && typeof v.id === 'string' && v.id)
    .map((v) => ({
      label: v.label,
      value: v.id,
      sample: v.sample || fallbackVoiceSample(v.label),
    }))
}

/**
 * 后端不可用时的内置兜底清单（只放最保险的一条：默认音色）。
 * ⚠️ 与后端 `TTS_VOICES` 不是同一份数据，别在这里补全清单 —— 会与后端漂移；
 * 这里只保证「后端挂了，默认音色仍能选、仍能试听」。
 */
export const DEFAULT_TTS_VOICES: TtsVoiceEntry[] = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女声·自然）', sample: fallbackVoiceSample('晓晓（女声·自然）') },
]
