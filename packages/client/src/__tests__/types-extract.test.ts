import { describe, it, expect } from 'vitest'
import {
  extractText,
  extractReasoning,
  extractToolCalls,
  extractFiles,
  extractSkillMatches,
  isMessageStreaming,
  isMessageError,
  isMessageComplete,
} from '../utils/content-blocks'
import type { ContentBlock } from '../types'

/** 混合内容块：文本 + 推理 + 工具 + 文件 + 技能 */
function buildBlocks(): ContentBlock[] {
  return [
    { type: 'text', text: '第一段' },
    { type: 'reasoning', text: '思考内容', turn: 1 },
    { type: 'tool-call', id: 't1', name: 'web_search', args: '{}', status: 'done' },
    { type: 'file', name: 'a.txt', path: 'a.txt', mime: 'text/plain' },
    { type: 'skill-match', name: '网络搜索' },
    { type: 'text', text: '第二段' },
  ]
}

describe('extractText 文本提取', () => {
  it('只提取 text 块并按行合并', () => {
    expect(extractText(buildBlocks())).toBe('第一段\n第二段')
  })

  it('空数组返回空串', () => {
    expect(extractText([])).toBe('')
  })

  it('无文本块返回空串', () => {
    expect(extractText([{ type: 'file', name: 'x', path: 'x', mime: 'x' }])).toBe('')
  })
})

describe('extract* 分类提取', () => {
  it('reasoning 提取', () => {
    const r = extractReasoning(buildBlocks())
    expect(r).toHaveLength(1)
    expect(r[0].text).toBe('思考内容')
  })

  it('tool-call 提取', () => {
    const t = extractToolCalls(buildBlocks())
    expect(t).toHaveLength(1)
    expect(t[0].name).toBe('web_search')
  })

  it('file 提取', () => {
    const f = extractFiles(buildBlocks())
    expect(f).toHaveLength(1)
    expect(f[0].name).toBe('a.txt')
  })

  it('skill-match 提取', () => {
    const s = extractSkillMatches(buildBlocks())
    expect(s).toHaveLength(1)
    expect(s[0].name).toBe('网络搜索')
  })
})

describe('消息状态判断', () => {
  it('streaming/pending 视为生成中', () => {
    expect(isMessageStreaming({ status: 'streaming' } as any)).toBe(true)
    expect(isMessageStreaming({ status: 'pending' } as any)).toBe(true)
    expect(isMessageStreaming({ status: 'complete' } as any)).toBe(false)
  })

  it('error/complete 判断', () => {
    expect(isMessageError({ status: 'error' } as any)).toBe(true)
    expect(isMessageComplete({ status: 'complete' } as any)).toBe(true)
    expect(isMessageComplete({ status: 'streaming' } as any)).toBe(false)
  })
})
