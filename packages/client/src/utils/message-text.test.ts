/**
 * 消息纯文本提取单测（P1-04 下沉自 ChatView.vue）
 */
import { describe, it, expect } from 'vitest'
import { textOf, messagePlainText, searchContent } from './message-text'
import type { ChatMessage } from '@/types'

describe('textOf', () => {
  it('字符串 content 原样返回', () => {
    expect(textOf('你好')).toBe('你好')
  })

  it('ContentBlock[] 只取 text 块并以换行拼接', () => {
    const blocks = [
      { type: 'text', text: '第一段' },
      { type: 'reasoning', text: '思考不应出现' },
      { type: 'text', text: '第二段' },
    ] as unknown as ChatMessage['content']
    expect(textOf(blocks)).toBe('第一段\n第二段')
  })

  it('空数组返回空串', () => {
    expect(textOf([] as unknown as ChatMessage['content'])).toBe('')
  })
})

describe('messagePlainText', () => {
  it('兼容 string / ContentBlock[]', () => {
    expect(messagePlainText({ content: 'hi' })).toBe('hi')
    expect(messagePlainText({ content: [{ type: 'text', text: 'a' }] })).toBe('a')
  })

  it('缺失 / 非法 content 返回空串，不抛错', () => {
    expect(messagePlainText(null)).toBe('')
    expect(messagePlainText(undefined)).toBe('')
    expect(messagePlainText({})).toBe('')
    expect(messagePlainText({ content: 123 })).toBe('')
    expect(messagePlainText({ content: null })).toBe('')
  })
})

describe('searchContent', () => {
  it('只接受字符串（其他类型返回空串）', () => {
    expect(searchContent([{ type: 'text', text: 'x' }])).toBe('')
    expect(searchContent(undefined)).toBe('')
    expect(searchContent(42)).toBe('')
  })

  it('短文本原样返回', () => {
    expect(searchContent('短文本')).toBe('短文本')
  })

  it('超过 200 字符截断并加省略号', () => {
    const long = 'x'.repeat(250)
    const out = searchContent(long)
    expect(out.length).toBe(203)      // 200 + '...'
    expect(out.endsWith('...')).toBe(true)
    expect(out.slice(0, 200)).toBe('x'.repeat(200))
  })

  it('恰好 200 字符不截断', () => {
    const exact = 'y'.repeat(200)
    expect(searchContent(exact)).toBe(exact)
  })
})
