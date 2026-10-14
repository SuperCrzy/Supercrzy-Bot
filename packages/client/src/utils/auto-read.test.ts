import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  AUTO_READ_MODES,
  DEFAULT_AUTO_READ_MODE,
  isWindowForeground,
  normalizeAutoReadMode,
  shouldAutoRead,
} from './auto-read'

/** 判定输入的四种组合（前景/后台 × 成功/失败） */
const base = { mode: 'background' as unknown, ok: true, hasText: true, foreground: false }

describe('auto-read — 档位归一化', () => {
  it('三个合法档位原样返回', () => {
    for (const m of AUTO_READ_MODES) expect(normalizeAutoReadMode(m)).toBe(m)
  })

  it('默认档位 = background（老板 2026-09-27 拍板）', () => {
    expect(DEFAULT_AUTO_READ_MODE).toBe('background')
  })

  it('脏值 / 空值 / 老库缺键 → 落回默认档，不崩也不意外变 off', () => {
    for (const v of [undefined, null, '', '  ', 'ON', 'true', 1, {}, [], 'BACKGROUND']) {
      expect(normalizeAutoReadMode(v)).toBe('background')
    }
  })
})

describe('auto-read — 该不该自动读', () => {
  it('always：前台也读', () => {
    expect(shouldAutoRead({ ...base, mode: 'always', foreground: true })).toBe(true)
    expect(shouldAutoRead({ ...base, mode: 'always', foreground: false })).toBe(true)
  })

  it('background：只在窗口不在前台时读（不打扰正看屏幕的人）', () => {
    expect(shouldAutoRead({ ...base, mode: 'background', foreground: false })).toBe(true)
    expect(shouldAutoRead({ ...base, mode: 'background', foreground: true })).toBe(false)
  })

  it('off：任何情况都不自动读', () => {
    expect(shouldAutoRead({ ...base, mode: 'off', foreground: false })).toBe(false)
    expect(shouldAutoRead({ ...base, mode: 'off', foreground: true })).toBe(false)
  })

  it('本轮失败/中断 → 任何档位都不读（念失败任务的半截内容是负价值）', () => {
    for (const mode of [...AUTO_READ_MODES, undefined, 'garbage']) {
      expect(shouldAutoRead({ mode, ok: false, hasText: true, foreground: false })).toBe(false)
    }
  })

  it('无可朗读文本（纯代码块/空回复）→ 不读，且不能只靠"档位是 always"就出声', () => {
    for (const mode of [...AUTO_READ_MODES, undefined]) {
      expect(shouldAutoRead({ mode, ok: true, hasText: false, foreground: false })).toBe(false)
    }
  })

  it('决策顺序：失败 + 无文本 + always + 后台 → 仍是不读', () => {
    expect(shouldAutoRead({ mode: 'always', ok: false, hasText: false, foreground: false })).toBe(false)
  })

  it('未归一化的脏档位在判定里等价于默认档（后台读、前台不读）', () => {
    expect(shouldAutoRead({ mode: 'xyz', ok: true, hasText: true, foreground: false })).toBe(true)
    expect(shouldAutoRead({ mode: 'xyz', ok: true, hasText: true, foreground: true })).toBe(false)
  })
})

describe('auto-read — 前台判定', () => {
  const origDoc = (globalThis as any).document
  afterEach(() => { (globalThis as any).document = origDoc })

  function setDoc(doc: unknown) {
    ;(globalThis as any).document = doc
  }

  it('无 document（SSR/纯逻辑环境）→ 保守视为前台（宁可不读，不可突然出声）', () => {
    setDoc(undefined)
    expect(isWindowForeground()).toBe(true)
  })

  it('标签页切走（hidden）→ 后台', () => {
    setDoc({ visibilityState: 'hidden', hasFocus: () => true })
    expect(isWindowForeground()).toBe(false)
  })

  it('窗口失去焦点但页面仍 visible（Electron 最小化/切到别 app）→ 后台', () => {
    setDoc({ visibilityState: 'visible', hasFocus: () => false })
    expect(isWindowForeground()).toBe(false)
  })

  it('可见且聚焦 → 前台', () => {
    setDoc({ visibilityState: 'visible', hasFocus: () => true })
    expect(isWindowForeground()).toBe(true)
  })

  it('缺 visibilityState / 缺 hasFocus 时按缺失侧不否决（只有一侧能判就别硬判后台）', () => {
    setDoc({ hasFocus: () => false })
    expect(isWindowForeground()).toBe(false)
    setDoc({ visibilityState: 'hidden' })
    expect(isWindowForeground()).toBe(false)
    setDoc({ visibilityState: 'visible' })
    expect(isWindowForeground()).toBe(true)
    setDoc({})
    expect(isWindowForeground()).toBe(true)
  })

  it('hasFocus 抛错时不崩（视为前台）', () => {
    setDoc({ visibilityState: 'visible', hasFocus: () => { throw new Error('nope') } })
    expect(() => isWindowForeground()).not.toThrow()
  })
})
