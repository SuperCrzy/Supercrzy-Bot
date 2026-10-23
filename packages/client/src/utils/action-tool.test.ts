import { describe, it, expect } from 'vitest'
import {
  parseToolSearchPayload,
  parseBrowserCall,
  parseComputerUseCall,
  firstLine,
} from './action-tool'

describe('parseToolSearchPayload', () => {
  it('命中态：解析 - name: desc 行', () => {
    const r = parseToolSearchPayload('按需工具（已加载，可直接调用）：\n- generate_image: 生成图片\n- draw_diagram: 画图', '图像')
    expect(r?.kind).toBe('hits')
    expect(r?.query).toBe('图像')
    expect(r?.hits).toEqual([
      { name: 'generate_image', description: '生成图片' },
      { name: 'draw_diagram', description: '画图' },
    ])
  })

  it('列全量态：逗号名单', () => {
    const r = parseToolSearchPayload('按需工具（5 个，可直接调用）：\ngenerate_image, video_edit, browser, bg_task, get_goal')
    expect(r?.kind).toBe('list')
    expect(r?.hits.map((h) => h.name)).toEqual(['generate_image', 'video_edit', 'browser', 'bg_task', 'get_goal'])
  })

  it('未找到态：hits 空、不返回 null（卡片显示"无命中"而不是原文）', () => {
    const r = parseToolSearchPayload('未找到与「xyz」匹配的按需工具。', 'xyz')
    expect(r?.kind).toBe('hits')
    expect(r?.hits).toEqual([])
  })

  it('空/坏输入返回 null', () => {
    expect(parseToolSearchPayload('')).toBeNull()
    expect(parseToolSearchPayload(undefined)).toBeNull()
    expect(parseToolSearchPayload('完全无关的自由文本')).toBeNull()
  })
})

describe('parseBrowserCall', () => {
  it('navigate 提取 url；click 提取文本或坐标', () => {
    expect(parseBrowserCall('{"action":"navigate","url":"https://a.com"}')).toEqual({ action: 'navigate', target: 'https://a.com', extra: '' })
    expect(parseBrowserCall('{"action":"click","text":"登录"}')).toEqual({ action: 'click', target: '登录', extra: '' })
    expect(parseBrowserCall('{"action":"click","x":10,"y":20}')).toEqual({ action: 'click', target: '(10, 20)', extra: '' })
  })

  it('type 提取文本与 into；无目标动作 target 为空', () => {
    expect(parseBrowserCall('{"action":"type","text":"hi","into":"搜索框"}')).toEqual({ action: 'type', target: 'hi', extra: '搜索框' })
    expect(parseBrowserCall('{"action":"back"}')).toEqual({ action: 'back', target: '', extra: '' })
  })

  it('坏 JSON / 缺 action 返回 null', () => {
    expect(parseBrowserCall('{oops')).toBeNull()
    expect(parseBrowserCall('{"url":"https://a.com"}')).toBeNull()
    expect(parseBrowserCall(undefined)).toBeNull()
  })
})

describe('parseComputerUseCall', () => {
  it('参数在 args 子对象里', () => {
    expect(parseComputerUseCall('{"action":"click","args":{"x":1,"y":2}}')).toEqual({ action: 'click', target: '(1, 2)', extra: '' })
    expect(parseComputerUseCall('{"action":"open","args":{"name":"Safari"}}')).toEqual({ action: 'open', target: 'Safari', extra: '' })
    expect(parseComputerUseCall('{"action":"key","args":{"combo":"Cmd+C"}}')).toEqual({ action: 'key', target: 'Cmd+C', extra: '' })
  })

  it('无 args 子对象也不崩', () => {
    expect(parseComputerUseCall('{"action":"screenshot"}')).toEqual({ action: 'screenshot', target: '', extra: '' })
    expect(parseComputerUseCall('bad')).toBeNull()
  })
})

describe('firstLine', () => {
  it('取首行并 trim；空输入空串', () => {
    expect(firstLine('已打开 https://a.com（标题）\n[现页可见] ...')).toBe('已打开 https://a.com（标题）')
    expect(firstLine('')).toBe('')
    expect(firstLine(undefined)).toBe('')
  })
})
