/**
 * `createContentCoalescer` 行为测试（2026-09-28 正文真流式转发配套）
 *
 * 这套断言的意义：合并窗口是"正文从末尾爆发改成边收边发"时**唯一新增的中间层**，
 * 它一旦算错，症状分别是——
 *   · 首片被押住 → TTFT / 朗读开口白等一个窗口
 *   · 阈值双向都失效 → 要么退化成"逐 delta 直发"（SSE 写次数 ×5，背压）
 *     ，要么退化成"攒到最后一起发"（回到改动前的老毛病）
 *   · 丢字/乱序 → 客户端 `msg.content` 与 flow 对账直接崩（flow-reconcile 不变量）
 *
 * 所以每条都写成**双向**断言：既给"该发的"也给"不该发的"。
 */
import { describe, it, expect } from 'vitest'
import { createContentCoalescer, CONTENT_FLUSH_MS, CONTENT_FLUSH_CHARS } from './content-coalescer'

describe('createContentCoalescer 基本窗口语义', () => {
  it('首片无条件立即发——不被窗口押 40ms', () => {
    const c = createContentCoalescer()
    // 只投 1 个字，且时间几乎没走（now=1 是"刚开局"）
    expect(c.push('甲', 1)).toBe('甲')
    expect(c.emittedBatches).toBe(1)
    expect(c.pendingLength).toBe(0)
  })

  it('窗口未到且未攒够 → 押着不发（这才是合并）', () => {
    const c = createContentCoalescer({ windowMs: 40, maxChars: 16 })
    expect(c.push('甲', 1000)).toBe('甲') // 首片立即发
    expect(c.push('乙', 1010)).toBeNull() // 10ms 后、只 1 字 → 押着
    expect(c.push('丙', 1020)).toBeNull()
    expect(c.pendingLength).toBe(2)
    expect(c.emittedBatches).toBe(1)
  })

  it('攒够 maxChars 立即发，不等窗口', () => {
    const c = createContentCoalescer({ windowMs: 10_000, maxChars: 4 })
    expect(c.push('甲', 1000)).toBe('甲') // 首片（不占后续 4 字配额）
    expect(c.push('乙', 1001)).toBeNull()
    expect(c.push('丙', 1002)).toBeNull()
    expect(c.push('丁', 1003)).toBeNull()
    // 第 4 个字到位即发：此时距上次只过了 3ms（窗口 10s 远未到期），但字数阈值先到
    expect(c.push('戊', 1004)).toBe('乙丙丁戊')
    expect(c.emittedBatches).toBe(2)
  })

  it('窗口到期（哪怕只有 1 个字）也必须发——否则慢模型会把字无限押住', () => {
    const c = createContentCoalescer({ windowMs: 40, maxChars: 1000 })
    expect(c.push('甲', 1000)).toBe('甲')
    expect(c.push('乙', 1010)).toBeNull()
    expect(c.push('丙', 1039)).toBeNull() // 39ms，还差 1ms
    expect(c.push('丁', 1040)).toBe('乙丙丁') // 满 40ms → 全发
  })

  it('flush 取出尾巴；空 pending 的 flush 返回 null（不产生空 content_chunk 事件）', () => {
    const c = createContentCoalescer({ windowMs: 1000, maxChars: 1000 })
    expect(c.push('甲', 1000)).toBe('甲')
    c.push('乙', 1001)
    expect(c.flush(1002)).toBe('乙')
    expect(c.flush(1003)).toBeNull()
  })

  it('空串投入不改变任何状态', () => {
    const c = createContentCoalescer()
    expect(c.push('', 1000)).toBeNull()
    expect(c.emittedBatches).toBe(0)
    expect(c.pendingLength).toBe(0)
  })

  it('默认常量就是标定值（改常量必须连带改标定值，别偷偷漂）', () => {
    expect(CONTENT_FLUSH_MS).toBe(40)
    expect(CONTENT_FLUSH_CHARS).toBe(16)
  })
})

describe('createContentCoalescer 不变量', () => {
  it('顺序无损：任意增量序列，发出批次的拼接必须逐字等于输入', () => {
    const c = createContentCoalescer()
    const deltas = ['a', 'bb', '中文', '', 'x', '一', '二三四五', '！？', 'Z']
    let input = ''
    const emitted: string[] = []
    let t = 1000
    for (let round = 0; round < 40; round++) {
      for (const d of deltas) {
        input += d
        t += 3
        const out = c.push(d, t)
        if (out) emitted.push(out)
        if (round % 7 === 0) {
          const tail = c.flush(t)
          if (tail) emitted.push(tail)
        }
      }
    }
    const tail = c.flush(t + 1000)
    if (tail) emitted.push(tail)
    expect(emitted.join('')).toBe(input)
    expect(c.pendingLength).toBe(0)
    // 反向：如果实现里漏掉任何一段，长度就会短
    expect(emitted.join('').length).toBe(input.length)
  })

  it('写次数上界：按实测上游节奏（875 delta / 1375 字 / 6580ms）模拟，写次数必须落在窗口预算内', () => {
    // 探针（/tmp/probe-upstream-pace.mjs）实测：正文首字→末字 6580ms、875 个 delta、1375 字。
    // 这条断言同时钉住两个方向的退化：
    //   · 若退化成"逐 delta 直发" → emitted 会飙到 875，超过上界
    //   · 若退化成"攒到最后一起发" → emitted 会塌到个位数，跌破下界
    const TOTAL_DELTAS = 875
    const TOTAL_MS = 6580
    const TOTAL_CHARS = 1375
    const c = createContentCoalescer()
    const emitted: string[] = []
    let charsLeft = TOTAL_CHARS
    for (let i = 0; i < TOTAL_DELTAS; i++) {
      // 均摊到 1375 字：前 500 个 delta 各 2 字，其余各 1 字（500*2 + 375 = 1375）
      const len = i < 500 ? 2 : 1
      charsLeft -= len
      const t = 1000 + Math.round((i * TOTAL_MS) / TOTAL_DELTAS)
      const out = c.push('字'.repeat(len), t)
      if (out) emitted.push(out)
    }
    expect(charsLeft).toBe(0)
    const tail = c.flush(1000 + TOTAL_MS)
    if (tail) emitted.push(tail)

    expect(emitted.join('')).toBe('字'.repeat(TOTAL_CHARS))
    // 窗口 40ms / 6580ms ⇒ 理论 ~165 批；理论上界 = 时长/窗口 + 2（首片不等窗口）
    expect(c.emittedBatches).toBeLessThanOrEqual(Math.floor(TOTAL_MS / CONTENT_FLUSH_MS) + 2)
    // 下界：必须真的在持续发，不能攒成一坨
    expect(c.emittedBatches).toBeGreaterThanOrEqual(40)
    // 与原回放（1375/8 ≈ 172 批）同量级，不应被放大
    expect(c.emittedBatches).toBeLessThan(172)
  })

  it('慢模型（delta 间隔远大于窗口）下不会把写次数放大', () => {
    const c = createContentCoalescer()
    const emitted: string[] = []
    // 每 500ms 来 1 个字：窗口早过期 ⇒ 每个 delta 立即发，写次数 = delta 数（本来就不密集）
    for (let i = 0; i < 20; i++) {
      const out = c.push('字', 1000 + i * 500)
      if (out) emitted.push(out)
    }
    expect(c.emittedBatches).toBe(20)
    expect(emitted.join('')).toBe('字'.repeat(20))
  })
})
