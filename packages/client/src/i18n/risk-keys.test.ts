/**
 * 风险等级文案的真实解析校验（2026-10-22）
 *
 * 为什么不能只 grep：`t('chatui.riskX')` 少一个 key 时 vue-i18n **不报错**，
 * 直接把 key 路径当文本渲染出来（界面上会出现 "chatui.riskHigh"）。
 * 同理，en 块里贴了中文也完全静默。这组测试走 createI18n 真实解析，把这两类静默故障钉住。
 */
import { describe, it, expect } from 'vitest'
import { createI18n } from 'vue-i18n'
import { messages } from './index'

const LOCALES = ['zh-CN', 'en-US'] as const
const KEYS = [
  'chatui.riskLow',
  'chatui.riskMedium',
  'chatui.riskHigh',
  'chatui.riskHintLow',
  'chatui.riskHintMedium',
  'chatui.riskHintHigh',
] as const

function tIn(locale: (typeof LOCALES)[number], key: string): string {
  const i18n = createI18n({ legacy: false, locale, fallbackLocale: locale, messages: messages as any })
  return i18n.global.t(key)
}

describe('风险等级文案：两种语言都必须能真实解析', () => {
  for (const locale of LOCALES) {
    for (const key of KEYS) {
      it(`${locale} ${key} → 非空且不等于 key 本身`, () => {
        const text = tIn(locale, key)
        expect(text, `${key} 解析失败（漏 key 或拼错命名空间）`).not.toBe(key)
        expect(text.trim().length).toBeGreaterThan(0)
        expect(text).not.toContain('{') // 不许残留占位符
      })
    }
  }

  it('中英文不能是同一串（防 en 块里贴中文）', () => {
    for (const key of KEYS) {
      expect(tIn('en-US', key), `${key} 的英文与中文相同，en 块大概率没翻译`).not.toBe(tIn('zh-CN', key))
    }
  })
})

describe('标签用词统一', () => {
  it('中文三个等级都用「风险」词根（旧值「高危」与「中风险」不一致）', () => {
    for (const key of ['chatui.riskLow', 'chatui.riskMedium', 'chatui.riskHigh'] as const) {
      expect(tIn('zh-CN', key)).toContain('风险')
    }
  })
  it('英文对应 Low / Medium / High risk', () => {
    expect(tIn('en-US', 'chatui.riskLow')).toBe('Low risk')
    expect(tIn('en-US', 'chatui.riskMedium')).toBe('Medium risk')
    expect(tIn('en-US', 'chatui.riskHigh')).toBe('High risk')
  })
})

describe('说明文案必须讲清"为什么"', () => {
  it('高风险要点明不可撤销 +「全部允许」跳不过', () => {
    expect(tIn('zh-CN', 'chatui.riskHintHigh')).toContain('不可撤销')
    expect(tIn('zh-CN', 'chatui.riskHintHigh')).toContain('本会话全部允许')
  })
  it('中风险要点明有副作用 + 可被「全部允许」跳过', () => {
    expect(tIn('zh-CN', 'chatui.riskHintMedium')).toContain('副作用')
    expect(tIn('zh-CN', 'chatui.riskHintMedium')).toContain('本会话全部允许')
  })
})

describe('token 估算提示文案（估算值必须在界面上说得清）', () => {
  it('两种语言都能真实解析', () => {
    for (const locale of LOCALES) {
      const text = tIn(locale, 'chat.tokensEstimated')
      expect(text, `${locale} 的 chat.tokensEstimated 解析失败`).not.toBe('chat.tokensEstimated')
      expect(text.trim().length).toBeGreaterThan(0)
    }
  })
  it('中英文不同 + 都点明"估算"而非"真实"', () => {
    expect(tIn('en-US', 'chat.tokensEstimated')).not.toBe(tIn('zh-CN', 'chat.tokensEstimated'))
    expect(tIn('zh-CN', 'chat.tokensEstimated')).toContain('估算')
    expect(tIn('en-US', 'chat.tokensEstimated')).toMatch(/estimated/i)
  })
})

describe('用量页的估算占比文案', () => {
  function tWith(locale: (typeof LOCALES)[number], key: string, params: Record<string, unknown>) {
    const i18n = createI18n({ legacy: false, locale, fallbackLocale: locale, messages: messages as any })
    return i18n.global.t(key, params)
  }

  it('estimatedShare 能替换占位符（不留 {n} 字面量）', () => {
    for (const locale of LOCALES) {
      const text = tWith(locale, 'usage.estimatedShare', { n: 42 })
      expect(text).toContain('42')
      expect(text).not.toContain('{')
    }
  })

  it('estimatedHint 两种语言都非空且点明"估算"', () => {
    expect(tIn('zh-CN', 'usage.estimatedHint')).toContain('估算')
    expect(tIn('en-US', 'usage.estimatedHint')).toMatch(/estimat/i)
  })
})

describe('任务明细表格文案（B4）', () => {
  const TABLE_KEYS = [
    'usage.taskWindowLabel',
    'usage.taskWindow7',
    'usage.taskWindow30',
    'usage.taskWindowAll',
    'usage.taskCol',
    'usage.taskStatusCol',
    'usage.taskTokensCol',
    'usage.taskCostCol',
    'usage.taskDurationCol',
    'usage.taskUpdatedCol',
  ] as const

  for (const locale of LOCALES) {
    for (const key of TABLE_KEYS) {
      it(`${locale} ${key} → 真实解析（不漏 key）`, () => {
        const text = tIn(locale, key)
        expect(text, `${key} 解析失败`).not.toBe(key)
        expect(text.trim().length).toBeGreaterThan(0)
      })
    }
  }

  it('taskTruncated 的两个占位符都会被替换', () => {
    const i18n = createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages: messages as any })
    const text = i18n.global.t('usage.taskTruncated', { shown: 50, total: 137 })
    expect(text).toContain('50')
    expect(text).toContain('137')
    expect(text).not.toContain('{')
  })
})
