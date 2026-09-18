/**
 * utils/artifact-kind 直测（P1-04 拆分配套，2026-09-18）
 * 这些判定原内联在 ChatView.vue，无法直测；抽出后锁住行为，避免以后改判据时无声回归。
 */
import { describe, it, expect } from 'vitest'
import {
  isArtifactImage, isArtifactSheet, isArtifactDoc,
  deliverySummaryArtifacts, deliverySummaryExpanded, toggleDeliverySummary,
  deliveryStatusKey, formatArtifactTime, DELIVERY_SUMMARY_MAX,
} from './artifact-kind'

describe('产物类型判定', () => {
  it('图片类：png/jpg/jpeg/gif/webp/svg/ico（大小写不敏感）', () => {
    for (const p of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.svg', 'g.ico']) {
      expect(isArtifactImage({ path: p }), p).toBe(true)
    }
    expect(isArtifactImage({ path: 'a.txt' })).toBe(false)
  })

  it('表格类：xls/xlsx/csv/tsv', () => {
    for (const p of ['a.xls', 'b.xlsx', 'c.csv', 'd.tsv']) expect(isArtifactSheet({ path: p }), p).toBe(true)
    expect(isArtifactSheet({ path: 'a.md' })).toBe(false)
  })

  it('文档类：doc/docx/pdf/md/txt/html/htm', () => {
    for (const p of ['a.doc', 'b.docx', 'c.pdf', 'd.md', 'e.txt', 'f.html', 'g.htm']) expect(isArtifactDoc({ path: p }), p).toBe(true)
    expect(isArtifactDoc({ path: 'a.png' })).toBe(false)
  })

  it('path 缺失时回退用 name 判定', () => {
    expect(isArtifactImage({ name: 'x.png' })).toBe(true)
    expect(isArtifactSheet({ name: 'y.csv' })).toBe(true)
    expect(isArtifactDoc({ name: 'z.pdf' })).toBe(true)
  })

  it('都缺失时判为 false（不抛错）', () => {
    expect(isArtifactImage({})).toBe(false)
    expect(isArtifactSheet({})).toBe(false)
    expect(isArtifactDoc({})).toBe(false)
  })
})

describe('交付摘要折叠', () => {
  const mk = (n: number) => ({ deliverySummary: { artifacts: Array.from({ length: n }, (_, i) => ({ name: `a${i}` })) } })

  it('默认只给前 3 个', () => {
    expect(DELIVERY_SUMMARY_MAX).toBe(3)
    expect(deliverySummaryArtifacts(mk(5))).toHaveLength(3)
  })

  it('展开后给全部', () => {
    const m: any = mk(5)
    m._dsExpanded = true
    expect(deliverySummaryArtifacts(m)).toHaveLength(5)
  })

  it('无产物返回空数组（不抛错）', () => {
    expect(deliverySummaryArtifacts({})).toEqual([])
    expect(deliverySummaryArtifacts(undefined)).toEqual([])
  })

  it('可传入自定义上限', () => {
    expect(deliverySummaryArtifacts(mk(5), 2)).toHaveLength(2)
  })

  it('expanded 读取与 toggle 取反', () => {
    const m: any = {}
    expect(deliverySummaryExpanded(m)).toBe(false)
    toggleDeliverySummary(m)
    expect(deliverySummaryExpanded(m)).toBe(true)
    toggleDeliverySummary(m)
    expect(deliverySummaryExpanded(m)).toBe(false)
  })

  it('toggle 传空不抛错', () => {
    expect(() => toggleDeliverySummary(undefined)).not.toThrow()
  })
})

describe('交付状态 i18n key', () => {
  it('已完成 / 已取消 / 失败', () => {
    expect(deliveryStatusKey('completed')).toBe('chat.deliveryDone')
    expect(deliveryStatusKey('cancelled')).toBe('chat.deliveryCancelled')
    expect(deliveryStatusKey('failed')).toBe('chat.deliveryFailed')
  })

  it('缺省视为已完成', () => {
    expect(deliveryStatusKey(undefined)).toBe('chat.deliveryDone')
  })

  it('未知状态（含 paused 等）落失败，不会渲染出空白', () => {
    expect(deliveryStatusKey('paused')).toBe('chat.deliveryFailed')
    expect(deliveryStatusKey('whatever')).toBe('chat.deliveryFailed')
  })
})

describe('产物时间格式化（SQLite UTC → 本地）', () => {
  it('空串/非法值返回空串', () => {
    expect(formatArtifactTime('')).toBe('')
    expect(formatArtifactTime('not-a-date')).toBe('')
  })

  it('SQLite 形态（空格分隔、无 Z）按 UTC 解析，结果等于显式 UTC 时间', () => {
    const expected = new Date('2026-09-18T03:00:00Z').toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    expect(formatArtifactTime('2026-09-18 03:00:00', 'zh-CN')).toBe(expected)
  })

  it('已带时区标记的 ISO 串原样解析', () => {
    const expected = new Date('2026-09-18T03:00:00Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    expect(formatArtifactTime('2026-09-18T03:00:00Z', 'en-US')).toBe(expected)
  })

  it('输出形如 HH:mm（含 12 小时制 am/pm）', () => {
    expect(formatArtifactTime('2026-09-18 03:00:00', 'zh-CN')).toMatch(/\d{1,2}:\d{2}/)
    expect(formatArtifactTime('2026-09-18 03:00:00', 'en-US')).toMatch(/\d{1,2}:\d{2}/)
  })
})
