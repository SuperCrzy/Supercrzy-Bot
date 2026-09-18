/**
 * utils/share-export 直测（P1-04 拆分配套，2026-09-18）
 * Markdown 拼装、canvas 换行、分享图布局与绘制原本内联在 ChatView.vue 无法直测。
 */
import { describe, it, expect } from 'vitest'
import {
  safeFileName, buildConversationMarkdown, wrapText,
  computeShareBlocks, computeShareImageHeight, drawShareImage, SHARE_LAYOUT,
} from './share-export'

describe('safeFileName 文件名净化', () => {
  it('替换跨平台非法字符', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  it('中文与空格保留', () => {
    expect(safeFileName('周报 2026-09')).toBe('周报 2026-09')
  })

  it('空值回退默认名', () => {
    expect(safeFileName(undefined)).toBe('conversation')
    expect(safeFileName('')).toBe('conversation')
    expect(safeFileName(undefined, 'chat')).toBe('chat')
  })
})

describe('buildConversationMarkdown 对话导出', () => {
  const plainText = (m: any) => (typeof m.content === 'string' ? m.content : '')

  it('含一级标题与生成时间，正文用 --- 分隔', () => {
    const md = buildConversationMarkdown({
      title: '测试会话',
      messages: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好，有什么可以帮你' }],
      plainText, meLabel: '我', assistantLabel: 'SUPERCRZY',
      generatedAt: '2026-09-18 12:00',
    })
    expect(md.startsWith('# 测试会话\n\n> SUPERCRZY BOT · 2026-09-18 12:00\n')).toBe(true)
    expect(md).toContain('**我**\n\n你好')
    expect(md).toContain('**SUPERCRZY**\n\n你好，有什么可以帮你')
    expect(md.match(/---/g)).toHaveLength(2)
  })

  it('跳过 system 消息与空内容消息', () => {
    const md = buildConversationMarkdown({
      title: 't',
      messages: [
        { role: 'system', content: '内部提示' },
        { role: 'user', content: '   ' },
        { role: 'assistant', content: '正文' },
      ],
      plainText, meLabel: '我', assistantLabel: 'AI', generatedAt: 'x',
    })
    expect(md).not.toContain('内部提示')
    expect(md).toContain('正文')
    expect(md.match(/---/g)).toHaveLength(1)
  })

  it('只有标题没有可导出消息时仍返回标题块', () => {
    const md = buildConversationMarkdown({ title: '空会话', messages: [], plainText, meLabel: '我', assistantLabel: 'AI', generatedAt: 'x' })
    expect(md).toBe('# 空会话\n\n> SUPERCRZY BOT · x\n')
  })
})

/** 假 ctx：1 字符 = 10px，便于精确断言换行位置 */
const fakeMeasure = { measureText: (t: string) => ({ width: t.length * 10 }) }

describe('wrapText canvas 换行', () => {
  it('按宽度逐字符累积，超出即换行', () => {
    expect(wrapText(fakeMeasure, 'abcdefghij', 50)).toEqual(['abcde', 'fghij'])
  })

  it('保留段落间的空行', () => {
    expect(wrapText(fakeMeasure, 'a\n\nb', 50)).toEqual(['a', '', 'b'])
  })

  it('单行列宽内不切分', () => {
    expect(wrapText(fakeMeasure, 'abc', 50)).toEqual(['abc'])
  })

  it('空字符串返回一个空行（与原实现一致）', () => {
    expect(wrapText(fakeMeasure, '', 50)).toEqual([''])
  })

  it('单个超长字符不会死循环', () => {
    expect(wrapText(fakeMeasure, 'a', 0)).toEqual(['a'])
  })
})

describe('computeShareBlocks / 高度', () => {
  const plainText = (m: any) => (typeof m.content === 'string' ? m.content : '')

  it('块高 = chrome + 行数 × 行高', () => {
    const blocks = computeShareBlocks([{ role: 'user', content: 'abcdefghij' }], fakeMeasure, { plainText, textMaxW: 50 })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].lines).toEqual(['abcde', 'fghij'])
    expect(blocks[0].h).toBe(SHARE_LAYOUT.blockChromeH + 2 * SHARE_LAYOUT.lineH)
  })

  it('maxMessages 取末尾 N 条', () => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `m${i}` }))
    const blocks = computeShareBlocks(msgs, fakeMeasure, { plainText, maxMessages: 6 })
    expect(blocks).toHaveLength(6)
    expect(blocks[0].lines[0]).toBe('m2')
    expect(blocks[5].lines[0]).toBe('m7')
  })

  it('跳过空内容消息', () => {
    const blocks = computeShareBlocks(
      [{ role: 'user', content: '  ' }, { role: 'assistant', content: 'x' }],
      fakeMeasure, { plainText },
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].role).toBe('assistant')
  })

  it('总高 = 标题区 + 各块(高+间距) + 底部留白', () => {
    const blocks = [{ role: 'user', lines: ['a'], h: 100 }, { role: 'assistant', lines: ['b'], h: 50 }]
    expect(computeShareImageHeight(blocks)).toBe(SHARE_LAYOUT.titleH + (100 + 18) + (50 + 18) + SHARE_LAYOUT.pad)
  })

  it('无块时高度仍含标题区与留白', () => {
    expect(computeShareImageHeight([])).toBe(SHARE_LAYOUT.titleH + SHARE_LAYOUT.pad)
  })
})

/** 记录式假 ctx，用于断言绘制调用序列 */
function recorder() {
  const calls: any[] = []
  return {
    calls,
    ctx: {
      fillStyle: '',
      font: '',
      fillText: (t: string, x: number, y: number) => calls.push(['text', t, x, y]),
      fillRect: (x: number, y: number, w: number, h: number) => calls.push(['rect', x, y, w, h]),
      beginPath: () => calls.push(['begin']),
      roundRect: (x: number, y: number, w: number, h: number, r: number) => calls.push(['round', x, y, w, h, r]),
      fill: () => calls.push(['fill']),
    },
  }
}

describe('drawShareImage 绘制', () => {
  const blocks = [
    { role: 'user', lines: ['你好'], h: 94 },
    { role: 'assistant', lines: ['回复一', '回复二'], h: 120 },
  ]

  it('背景铺满整图', () => {
    const { ctx, calls } = recorder()
    drawShareImage(ctx, blocks, { title: '会话标题', dateText: '2026/9/18', meLabel: '我', assistantLabel: 'SUPERCRZY' })
    expect(calls[0]).toEqual(['rect', 0, 0, SHARE_LAYOUT.width, computeShareImageHeight(blocks)])
  })

  it('画标题、会话子标题与日期', () => {
    const { ctx, calls } = recorder()
    drawShareImage(ctx, blocks, { title: '会话标题', dateText: '2026/9/18', meLabel: '我', assistantLabel: 'SUPERCRZY' })
    const texts = calls.filter((c) => c[0] === 'text').map((c) => c[1])
    expect(texts).toContain('SUPERCRZY BOT')
    expect(texts).toContain('会话标题')
    expect(texts).toContain('2026/9/18')
  })

  it('每个块画圆角卡片 + 角色标签 + 全部文本行', () => {
    const { ctx, calls } = recorder()
    drawShareImage(ctx, blocks, { title: '', dateText: 'd', meLabel: '我', assistantLabel: 'SUPERCRZY' })
    const rounds = calls.filter((c) => c[0] === 'round')
    expect(rounds).toHaveLength(2)
    expect(rounds[0]).toEqual(['round', SHARE_LAYOUT.pad, SHARE_LAYOUT.titleH, SHARE_LAYOUT.width - SHARE_LAYOUT.pad * 2, 94, 16])
    const texts = calls.filter((c) => c[0] === 'text').map((c) => c[1])
    expect(texts).toContain('我')
    expect(texts.filter((t) => t === 'SUPERCRZY')).toHaveLength(1)
    expect(texts).toContain('你好')
    expect(texts).toContain('回复一')
    expect(texts).toContain('回复二')
  })

  it('无标题时跳过子标题绘制（不画空串）', () => {
    const { ctx, calls } = recorder()
    drawShareImage(ctx, blocks, { title: '', dateText: 'd', meLabel: '我', assistantLabel: 'A' })
    expect(calls.filter((c) => c[0] === 'text' && c[1] === '')).toHaveLength(0)
  })

  it('ctx 无 roundRect 时降级为直角矩形', () => {
    const calls: any[] = []
    const ctx = {
      fillStyle: '', font: '',
      fillText: (t: string) => calls.push(['text', t]),
      fillRect: (x: number, y: number, w: number, h: number) => calls.push(['rect', x, y, w, h]),
    }
    drawShareImage(ctx as any, blocks, { title: 't', dateText: 'd', meLabel: '我', assistantLabel: 'A' })
    // 1 次背景 + 2 次块底
    expect(calls.filter((c) => c[0] === 'rect')).toHaveLength(3)
    expect(calls.some((c) => c[0] === 'round')).toBe(false)
  })
})
