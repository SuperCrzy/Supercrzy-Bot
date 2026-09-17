/**
 * 附件类型判定与体积格式化单测（P1-04 下沉自 ChatView.vue）
 */
import { describe, it, expect } from 'vitest'
import { isImageType, isPdfType, isDocType, isSheetType, formatFileSize, formatArtifactSize } from './attachment'

describe('mime 判定', () => {
  it('图片按 image/ 前缀', () => {
    expect(isImageType('image/png')).toBe(true)
    expect(isImageType('image/jpeg')).toBe(true)
    expect(isImageType('text/plain')).toBe(false)
    expect(isImageType('')).toBe(false)
  })

  it('PDF 必须精确匹配', () => {
    expect(isPdfType('application/pdf')).toBe(true)
    expect(isPdfType('application/pdf-x')).toBe(false)
  })

  it('Word / 表格按关键字', () => {
    expect(isDocType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true)
    expect(isDocType('application/msword')).toBe(true)
    expect(isDocType('text/plain')).toBe(false)
    expect(isSheetType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true)
    expect(isSheetType('application/vnd.ms-excel')).toBe(true)
    expect(isSheetType('image/png')).toBe(false)
  })

  it('传入 undefined/null 不抛错', () => {
    expect(isImageType(undefined as unknown as string)).toBe(false)
    expect(isDocType(null as unknown as string)).toBe(false)
  })
})

describe('formatFileSize（带空格写法）', () => {
  it('B / KB / MB 边界', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB')
    expect(formatFileSize(1024 * 1024 * 2.5)).toBe('2.5 MB')
  })
})

describe('formatArtifactSize（无空格写法，0 值返回空串）', () => {
  it('0 / 空值返回空串（产物卡片不显示 "0B"）', () => {
    expect(formatArtifactSize(0)).toBe('')
    expect(formatArtifactSize(undefined as unknown as number)).toBe('')
  })

  it('B / KB / MB 边界（无空格）', () => {
    expect(formatArtifactSize(512)).toBe('512B')
    expect(formatArtifactSize(2048)).toBe('2.0KB')
    expect(formatArtifactSize(1024 * 1024 * 3)).toBe('3.0MB')
  })

  it('与 formatFileSize 的差异是历史行为，需保持一致（防视觉回归）', () => {
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatArtifactSize(1536)).toBe('1.5KB')
  })
})
