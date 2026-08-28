import { describe, it, expect } from 'vitest'
import { detectLocale } from '../utils/locale'

describe('detectLocale（i18n-first 语言检测）', () => {
  it('本地偏好优先：zh-CN / en-US 直接返回', () => {
    expect(detectLocale('zh-CN', 'en-US')).toBe('zh-CN')
    expect(detectLocale('en-US', 'zh-CN')).toBe('en-US')
  })

  it('无偏好时 zh 系浏览器语言 → zh-CN', () => {
    expect(detectLocale(null, 'zh-CN')).toBe('zh-CN')
    expect(detectLocale(null, 'zh-TW')).toBe('zh-CN')
    expect(detectLocale(null, 'zh-HK')).toBe('zh-CN')
    expect(detectLocale(null, 'zh')).toBe('zh-CN')
  })

  it('无偏好时非 zh 浏览器语言 → en-US（海外用户开箱英文）', () => {
    expect(detectLocale(null, 'en-US')).toBe('en-US')
    expect(detectLocale(null, 'en-GB')).toBe('en-US')
    expect(detectLocale(null, 'ja-JP')).toBe('en-US')
    expect(detectLocale(null, 'fr-FR')).toBe('en-US')
  })

  it('异常输入兜底 en-US', () => {
    expect(detectLocale(null, '')).toBe('en-US')
    expect(detectLocale(null, '')).toBe('en-US')
    expect(detectLocale('invalid', 'en')).toBe('en-US')
  })
})
