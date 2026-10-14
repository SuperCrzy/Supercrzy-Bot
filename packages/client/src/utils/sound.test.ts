// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * sound.ts 单测
 *
 * 为什么用「每次重新 import」：模块内缓存了 AudioContext 实例（audioCtx），
 * 不重置模块就会复用第一个测试的假 ctx，后续断言全部落到旧的记录数组里 —— 假绿。
 */

interface ParamEvent { kind: 'set' | 'ramp'; value: number; time: number }

class FakeParam {
  events: ParamEvent[] = []
  setValueAtTime(value: number, time: number) { this.events.push({ kind: 'set', value, time }) }
  exponentialRampToValueAtTime(value: number, time: number) { this.events.push({ kind: 'ramp', value, time }) }
}

interface Voice { osc: any; freq: FakeParam; gain: FakeParam; startAt: number[]; stopAt: number[] }

let voices: Voice[]
let resumeCalls: number
let throwOnCreate = false

function installFakeAudioContext(state: AudioContextState = 'running') {
  voices = []
  resumeCalls = 0
  throwOnCreate = false

  class FakeOscillator {
    type = 'sine'
    frequency = new FakeParam()
    startAt: number[] = []
    stopAt: number[] = []
    constructor() { if (throwOnCreate) throw new Error('no audio device') }
    connect() {}
    start(t: number) { this.startAt.push(t) }
    stop(t: number) { this.stopAt.push(t) }
  }
  class FakeGain {
    gain = new FakeParam()
    connect() {}
  }
  class FakeAudioContext {
    state: AudioContextState = state
    currentTime = 10 // 非 0 起点，能顺便验证是否真的用了 ctx.currentTime 做基准
    resume() { resumeCalls++; this.state = 'running'; return Promise.resolve() }
    createOscillator() {
      const osc = new FakeOscillator()
      // 成对记录：osc → voice（gain 在紧随其后的 createGain 里补上）
      voices.push({ osc, freq: osc.frequency, gain: null as any, startAt: osc.startAt, stopAt: osc.stopAt })
      return osc
    }
    createGain() {
      const g = new FakeGain()
      const last = voices[voices.length - 1]
      if (last) last.gain = g.gain
      return g
    }
  }
  ;(window as any).AudioContext = FakeAudioContext
  ;(window as any).webkitAudioContext = FakeAudioContext
}

/** 每次拿到全新模块实例（避免 audioCtx 单例串味） */
async function loadSound() {
  vi.resetModules()
  return await import('./sound')
}

beforeEach(() => {
  installFakeAudioContext()
})

describe('SOUND_TONES 内置音效表', () => {
  it('classic 与历史硬编码参数逐字一致（C5@0/0.2s + E5@0.15/0.3s，sine）', async () => {
    const { SOUND_TONES } = await loadSound()
    const classic = SOUND_TONES.find((t) => t.id === 'classic')!
    expect(classic).toBeTruthy()
    expect(classic.type).toBe('sine')
    expect(classic.notes).toEqual([
      { freq: 523, at: 0, dur: 0.2 },
      { freq: 659, at: 0.15, dur: 0.3 },
    ])
  })

  it('每款音效参数合法：id 唯一、频率/时长/偏移为正、音符非空', async () => {
    const { SOUND_TONES } = await loadSound()
    const ids = SOUND_TONES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const tone of SOUND_TONES) {
      expect(tone.type).toBeTruthy()
      expect(tone.notes.length).toBeGreaterThan(0)
      for (const n of tone.notes) {
        expect(n.freq).toBeGreaterThan(0)
        expect(n.dur).toBeGreaterThan(0)
        expect(n.at).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

describe('normalizeTone / normalizeVolume 归一', () => {
  it('非法音色一律回落 classic（合法值透传）', async () => {
    const { normalizeTone } = await loadSound()
    expect(normalizeTone('chord')).toBe('chord')
    expect(normalizeTone('down')).toBe('down')
    expect(normalizeTone('nope')).toBe('classic')
    expect(normalizeTone('')).toBe('classic')
    expect(normalizeTone(undefined)).toBe('classic')
    expect(normalizeTone(null)).toBe('classic')
    expect(normalizeTone(123)).toBe('classic')
  })

  it('音量夹到 [0.05, 0.4]，非数字回落 0.15', async () => {
    const { normalizeVolume, MIN_VOLUME, MAX_VOLUME, DEFAULT_VOLUME } = await loadSound()
    expect(MIN_VOLUME).toBe(0.05)
    expect(MAX_VOLUME).toBe(0.4)
    expect(DEFAULT_VOLUME).toBe(0.15)
    expect(normalizeVolume(0.25)).toBe(0.25)
    expect(normalizeVolume(0)).toBe(MIN_VOLUME)
    expect(normalizeVolume(-3)).toBe(MIN_VOLUME)
    expect(normalizeVolume(9)).toBe(MAX_VOLUME)
    expect(normalizeVolume('0.2')).toBe(0.2)
    expect(normalizeVolume(undefined)).toBe(DEFAULT_VOLUME)
    expect(normalizeVolume('abc')).toBe(DEFAULT_VOLUME)
    expect(normalizeVolume(NaN)).toBe(DEFAULT_VOLUME)
  })
})

describe('playCompletionTone 实际调度', () => {
  it('chord：3 个音，频率 523→659→784，起始 0/0.07/0.14，音量走入参 0.3', async () => {
    const { playCompletionTone } = await loadSound()
    playCompletionTone('chord', 0.3)
    expect(voices).toHaveLength(3)
    const freqs = voices.map((v) => v.freq.events[0].value)
    const starts = voices.map((v) => v.startAt[0])
    expect(freqs).toEqual([523, 659, 784])
    expect(starts).toEqual([10, 10.07, 10.14])
    expect(voices.every((v) => v.gain.events[0].value === 0.3)).toBe(true)
    // 每个音都以指数衰减收尾到 0.001（不是直接切）
    expect(voices.every((v) => v.gain.events[1]?.kind === 'ramp' && v.gain.events[1]?.value === 0.001)).toBe(true)
    expect(voices.every((v) => v.stopAt[0] > v.startAt[0])).toBe(true)
    // 波形按音效定义下发（chord = triangle）
    expect(voices.map((v) => v.osc.type)).toEqual(['triangle', 'triangle', 'triangle'])
  })

  it('非法音色回落 classic：2 个音 + 默认音量 0.15', async () => {
    const { playCompletionTone } = await loadSound()
    playCompletionTone('does-not-exist')
    expect(voices).toHaveLength(2)
    expect(voices.map((v) => v.freq.events[0].value)).toEqual([523, 659])
    expect(voices[0].gain.events[0].value).toBe(0.15)
  })

  it('兼容入口 playCompletionSound() 无参 = classic + 0.15（老调用点行为不变）', async () => {
    const { playCompletionSound } = await loadSound()
    playCompletionSound()
    expect(voices).toHaveLength(2)
    expect(voices.map((v) => v.freq.events[0].value)).toEqual([523, 659])
    expect(voices.map((v) => v.startAt[0])).toEqual([10, 10.15])
    expect(voices[1].stopAt[0]).toBeCloseTo(10.45, 5)
    expect(voices[0].gain.events[0].value).toBe(0.15)
    expect(voices.map((v) => v.osc.type)).toEqual(['sine', 'sine'])
  })

  it('音量入参越界时被夹取（不把音箱轰爆也不完全静音）', async () => {
    const { playCompletionTone } = await loadSound()
    playCompletionTone('single', 5)
    expect(voices[0].gain.events[0].value).toBe(0.4)
  })

  it('suspended 状态会尝试 resume（浏览器 autoplay 政策）', async () => {
    installFakeAudioContext('suspended')
    const { playCompletionTone } = await loadSound()
    playCompletionTone('classic')
    expect(resumeCalls).toBe(1)
    expect(voices).toHaveLength(2)
  })

  it('音频栈异常时静默失败，不抛给调用方', async () => {
    const { playCompletionTone } = await loadSound()
    throwOnCreate = true
    expect(() => playCompletionTone('classic', 0.2)).not.toThrow()
    expect(voices).toHaveLength(0)
  })

  it('没有 AudioContext（极端环境）也不抛', async () => {
    const { playCompletionTone } = await loadSound()
    delete (window as any).AudioContext
    delete (window as any).webkitAudioContext
    expect(() => playCompletionTone()).not.toThrow()
  })
})
