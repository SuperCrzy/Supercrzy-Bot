import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TTS_VOICES,
  fallbackVoiceSample,
  toVoiceOptions,
  voiceDisplayName,
  type TtsVoiceEntry,
} from './tts-voices'

/** 一句台词是否真的提到"自己"（从 label 取名字） */
function mentionsOwnName(sample: string, label: string): boolean {
  return sample.includes(voiceDisplayName(label))
}

describe('tts-voices — 试听台词', () => {
  it('中文音色：中文开场 + 中英混读品牌名（品牌名不翻译）', () => {
    expect(fallbackVoiceSample('晓晓（女声·自然）')).toBe('您好，我是晓晓，是你的 SUPERCRZY BOT.')
  })

  it('英文音色：英文开场（拿英文音色念中文自我介绍会很出戏）', () => {
    expect(fallbackVoiceSample('Aria（English）')).toBe("Hi, I'm Aria, your SUPERCRZY BOT.")
  })

  it('label 无括号 / 半角括号 / 空值都能取名', () => {
    expect(voiceDisplayName('云希')).toBe('云希')
    expect(voiceDisplayName('晓北(东北话)')).toBe('晓北')
    expect(voiceDisplayName('  ')).toBe('')
    expect(fallbackVoiceSample('')).toBe('您好，我是，是你的 SUPERCRZY BOT.') // 名字缺失也不崩，只是空洞
  })

  it('内置兜底清单：每一项的台词都必须提到自己的名字', () => {
    const bad = DEFAULT_TTS_VOICES.filter((v) => !mentionsOwnName(fallbackVoiceSample(v.label), v.label))
    expect(bad.map((v) => v.id)).toEqual([])
  })

  it('内置兜底清单：每一项都带 sample 且含品牌名（否则后端挂了"点名字自动试听"会哑）', () => {
    for (const v of DEFAULT_TTS_VOICES) {
      expect(v.sample, `${v.id} 缺 sample`).toBeTruthy()
      expect(v.sample).toContain('SUPERCRZY BOT')
    }
  })
})

describe('tts-voices — toVoiceOptions', () => {
  /** 模拟后端下发（含一条缺 sample 的，模拟旧后端/漏填） */
  const fromServer: TtsVoiceEntry[] = [
    { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女声·自然）', sample: '您好，我是晓晓，是你的 SUPERCRZY BOT.' },
    { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女声·活泼）' },
    { id: 'en-US-AriaNeural', label: 'Aria（English）', sample: "Hi, I'm Aria, your SUPERCRZY BOT." },
  ]

  it('后端下发的 sample 优先（不被兜底覆盖）', () => {
    const opts = toVoiceOptions(fromServer)
    expect(opts[0].sample).toBe('您好，我是晓晓，是你的 SUPERCRZY BOT.')
    expect(opts[1].sample).toBe('您好，我是晓伊，是你的 SUPERCRZY BOT.')
    expect(opts[2].sample).toBe("Hi, I'm Aria, your SUPERCRZY BOT.")
  })

  it('不管后端有没有给 sample，每一项都有能试听的台词、且提到自己的名字', () => {
    for (const o of toVoiceOptions(fromServer)) {
      expect(o.sample, `${o.value} 缺台词`).toBeTruthy()
      expect(mentionsOwnName(o.sample, o.label), `${o.value} 台词没提到自己`).toBe(true)
    }
  })

  it('value 必须取自 id（试听请求要靠它指定 voice）', () => {
    expect(toVoiceOptions(fromServer).map((o) => o.value)).toEqual([
      'zh-CN-XiaoxiaoNeural',
      'zh-CN-XiaoyiNeural',
      'en-US-AriaNeural',
    ])
  })

  it('空 / 非数组 / 脏条目 → 不崩、不产出无 value 的空选项', () => {
    expect(toVoiceOptions([])).toEqual([])
    expect(toVoiceOptions(null)).toEqual([])
    expect(toVoiceOptions(undefined)).toEqual([])
    expect(toVoiceOptions([{ id: '', label: '破' }, null as any, { label: '无id' } as any])).toEqual([])
  })
})
