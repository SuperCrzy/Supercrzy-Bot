import { describe, it, expect } from 'vitest'
import { extractSvgs, flowDiagramSet, autoExtractDiagrams, SVG_FALLBACK_HEAD } from './svg-extract'

const SVG = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'

describe('extractSvgs', () => {
  it('```svg 代码块：取块内完整 <svg>', () => {
    const text = '看图：\n\n```svg\n' + SVG + '\n```\n'
    expect(extractSvgs(text)).toEqual([SVG])
  })

  it('```xml 代码块同样识别（模型常把 SVG 标成 xml）', () => {
    const text = '```xml\n' + SVG + '\n```'
    expect(extractSvgs(text)).toEqual([SVG])
  })

  it('代码块里缺 <svg> 起始标签 → 补头，不丢弃（否则页面会裸露一段 XML）', () => {
    const broken = '<rect width="10" height="10"/><text>hi</text>'
    const out = extractSvgs('```svg\n' + broken + '\n```')
    expect(out).toHaveLength(1)
    expect(out[0].startsWith(SVG_FALLBACK_HEAD)).toBe(true)
    expect(out[0].endsWith('</svg>')).toBe(true)
  })

  it('正文裸 <svg>（没有代码块）也能提取', () => {
    expect(extractSvgs('结果是：' + SVG + '结束')).toEqual([SVG])
  })

  it('代码块内容不会被裸标签扫描二次计入（同一张图只出一次）', () => {
    const text = '```svg\n' + SVG + '\n```\n\n' + SVG
    expect(extractSvgs(text)).toHaveLength(2) // 块内 1 张 + 块外 1 张，块内的不算两遍
    expect(extractSvgs('```svg\n' + SVG + '\n```')).toHaveLength(1)
  })

  it('没有 SVG → 空数组（不能抛）', () => {
    expect(extractSvgs('普通文本')).toEqual([])
    expect(extractSvgs('')).toEqual([])
  })

  it('代码块里不像 XML 的内容不硬补壳', () => {
    expect(extractSvgs('```svg\n就是一段说明文字\n```')).toEqual([])
  })
})

describe('flowDiagramSet', () => {
  it('只收 diagram 节点，忽略 text/tool 节点', () => {
    const msg: any = {
      flow: [
        { kind: 'text', text: 'hi' },
        { kind: 'diagram', svg: SVG },
        { kind: 'tool', tool: { name: 'x' } },
      ],
    }
    const s = flowDiagramSet(msg)
    expect([...s]).toEqual([SVG])
  })

  it('无 flow → 空集合', () => {
    expect(flowDiagramSet({} as any).size).toBe(0)
  })
})

describe('autoExtractDiagrams', () => {
  it('flow 里已有的图不重复提取（否则同一张图渲染两次）', () => {
    const msg: any = { content: SVG, flow: [{ kind: 'diagram', svg: SVG }] }
    const n = autoExtractDiagrams(msg)
    expect(n).toBe(0)
    expect(msg.diagrams).toEqual([])
  })

  it('content 与 flow text 里的同一张图只收一份', () => {
    const msg: any = { content: SVG, flow: [{ kind: 'text', text: SVG }] }
    expect(autoExtractDiagrams(msg)).toBe(1)
    expect(msg.diagrams).toHaveLength(1)
  })

  it('ContentBlock[] 形态的历史消息也能提取（解开 JSON 转义）', () => {
    const msg: any = { content: [{ type: 'text', text: SVG }] }
    expect(autoExtractDiagrams(msg)).toBe(1)
  })

  it('没有 <svg 时直接返回 0，且不创建空的 diagrams 数组（避免无意义渲染分支）', () => {
    const msg: any = { content: '纯文字回复' }
    expect(autoExtractDiagrams(msg)).toBe(0)
    expect(msg.diagrams).toBeUndefined()
  })

  it('重复调用幂等（流式每帧都会调）', () => {
    const msg: any = { content: SVG }
    expect(autoExtractDiagrams(msg)).toBe(1)
    expect(autoExtractDiagrams(msg)).toBe(0)
    expect(msg.diagrams).toHaveLength(1)
  })
})
