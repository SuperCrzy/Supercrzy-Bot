/**
 * useChatSpeech 编排层的判定单测（2026-09-28「边生成边朗读」）。
 *
 * 这里**故意把 useSpeech 整层 mock 掉**：本文件要钉的是"什么时候开读、什么时候不读、
 * 会不会重复读"这三个决策，播放机制本身由 useSpeech.test.ts 覆盖。
 * 混在一起测的后果是"play 次数对了但决策错了"这类问题两边都看不见。
 *
 * 决策里最容易出的两个 bug（这里各有一条用例点名）：
 *   ① 已经边生成边读过 → turnEnd 又整条读一遍（用户听到重复）
 *   ② 流式失败/中断后 speakingId 不归零（朗读按钮永久卡在"正在播放"）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope } from 'vue'
import { useChatSpeech, type UseChatSpeechOptions } from './useChatSpeech'

const h = vi.hoisted(() => ({
  calls: {
    speak: [] as string[],
    beginStream: [] as string[],
    append: [] as string[],
    endStream: 0,
    stop: 0,
  },
  opts: { beginStreamOk: true },
}))

vi.mock('./useSpeech', async () => {
  const { ref } = await import('vue')
  const speakingId = ref<string | null>(null)
  return {
    PRO_COOLDOWN_MS: 60_000,
    useSpeech: () => ({
      supported: ref(true),
      speakingId,
      paused: ref(false),
      proDegraded: ref(false),
      isPro: () => true,
      speak: (id: string) => {
        h.calls.speak.push(id)
        speakingId.value = id
      },
      beginStream: (id: string) => {
        h.calls.beginStream.push(id)
        if (!h.opts.beginStreamOk) return false
        speakingId.value = id
        return true
      },
      appendStreamText: (t: string) => {
        h.calls.append.push(t)
      },
      endStream: () => {
        h.calls.endStream += 1
      },
      stop: () => {
        h.calls.stop += 1
        speakingId.value = null
      },
      toggle: () => {},
      pause: () => {},
      resume: () => {},
    }),
  }
})

/** 260 字、带句末标点的文本（大于首块门槛 200 字，能切出 1 块） */
const LONG = '这是一段用于测试的长文本。'.repeat(20)

function mount(opts: Partial<UseChatSpeechOptions> = {}) {
  const scope = effectScope()
  const api = scope.run(() => useChatSpeech({ streamRead: () => true, foreground: () => false, ...opts }))!
  return { api, dispose: () => scope.stop() }
}

function msg(id: string, content = ''): any {
  return { id, role: 'assistant', content }
}

beforeEach(() => {
  h.calls.speak = []
  h.calls.beginStream = []
  h.calls.append = []
  h.calls.endStream = 0
  h.calls.stop = 0
  h.opts.beginStreamOk = true
})

describe('useChatSpeech 流式开读判定', () => {
  it('攒够一块 + 本轮本来会读 → 立刻开读', () => {
    const { api } = mount({ mode: () => 'background', foreground: () => false })
    api.feedStream(msg('m1'), LONG)
    expect(h.calls.beginStream).toEqual(['m1'])
    expect(h.calls.append.join('')).toContain('这是一段用于测试的长文本')
  })

  it('不够一块门槛（短回复）→ 不开流式，等 turnEnd 整条读', () => {
    const { api } = mount({ mode: () => 'always', foreground: () => true })
    api.feedStream(msg('m1', '好的，我来安排。'), '好的，我来安排。')
    expect(h.calls.beginStream).toEqual([])
    expect(h.calls.append).toEqual([])
    api.turnEnd(msg('m1', '好的，我来安排。'), true)
    expect(h.calls.speak).toEqual(['m1'])
  })

  it('窗口在前台 + background 档 → 不开读，turnEnd 也不读（盯着屏幕时不出声）', () => {
    const { api } = mount({ mode: () => 'background', foreground: () => true })
    api.feedStream(msg('m1', LONG), LONG)
    expect(h.calls.beginStream).toEqual([])
    api.turnEnd(msg('m1', LONG), true)
    expect(h.calls.speak).toEqual([])
  })

  it('档位为 off → 即使开关打开也不读', () => {
    const { api } = mount({ mode: () => 'off', streamRead: () => true, foreground: () => false })
    api.feedStream(msg('m1', LONG), LONG)
    expect(h.calls.beginStream).toEqual([])
    api.turnEnd(msg('m1', LONG), true)
    expect(h.calls.speak).toEqual([])
  })

  it('开关关闭 → 不走流式，但整条路径照常读', () => {
    const { api } = mount({ mode: () => 'always', streamRead: () => false, foreground: () => true })
    api.feedStream(msg('m1', LONG), LONG)
    expect(h.calls.beginStream).toEqual([])
    api.turnEnd(msg('m1', LONG), true)
    expect(h.calls.speak).toEqual(['m1'])
  })

  it('Pro 冷却中（beginStream 返回 false）→ 放弃流式，turnEnd 回落整条读，且不反复尝试', () => {
    h.opts.beginStreamOk = false
    const { api } = mount({ mode: () => 'always', streamRead: () => true, foreground: () => true })
    api.feedStream(msg('m1', LONG), LONG)
    api.feedStream(msg('m1', LONG), LONG)
    expect(h.calls.beginStream.length).toBe(1) // ← 只试一次，不每 chunk 空试
    expect(h.calls.append).toEqual([])
    api.turnEnd(msg('m1', LONG), true)
    expect(h.calls.speak).toEqual(['m1'])
  })

  it('缓冲硬上限：条件长期不成立时不无限攒字符串', () => {
    const { api } = mount({ mode: () => 'background', foreground: () => true })
    api.feedStream(msg('m1'), 'x'.repeat(9000))
    api.feedStream(msg('m1'), LONG)
    expect(h.calls.beginStream).toEqual([])
    expect(h.calls.append).toEqual([])
  })
})

describe('useChatSpeech 两级门槛（首块求快、后续求少切）', () => {
  it('逐句流式喂入 800 字 → 只切 2 块，且首块短、次块长', () => {
    const { api } = mount({ mode: () => 'always', foreground: () => true })
    const unit = '这是一句普通的结论。' // 10 字，含句末标点
    for (let i = 0; i < 80; i++) api.feedStream(msg('m1', unit.repeat(i + 1)), unit)

    expect(h.calls.append.length).toBe(2)            // ← 不是 4~5 块（那等于把固定成本付 N 次）
    expect(h.calls.append[0].length).toBeLessThan(300)   // 首块只为尽快出声
    expect(h.calls.append[1].length).toBeGreaterThan(500) // 后续块抬高门槛
    expect(h.calls.append.join('').replace(/。/g, '')).toContain('这是一句普通的结论')
  })
})

describe('useChatSpeech 不重复朗读（关键回归）', () => {  it('已经边生成边读过 → turnEnd 绝不再整条重读一遍', () => {
    const { api } = mount({ mode: () => 'always', foreground: () => true })
    api.feedStream(msg('m1', LONG), LONG)
    const streamed = h.calls.append.length
    expect(streamed).toBeGreaterThan(0)
    api.turnEnd(msg('m1', LONG), true)
    expect(h.calls.speak).toEqual([]) // ← 没有第二次朗读
    expect(h.calls.endStream).toBe(1)
  })

  it('残余零头在 turnEnd 时补读（不能丢尾巴）', () => {
    const { api } = mount({ mode: () => 'always', foreground: () => true })
    const head = '这是一段用于测试的长文本。'.repeat(16) // 208 字 → 刚好切出 1 块
    api.feedStream(msg('m1', head), head)
    expect(h.calls.append.length).toBe(1)
    api.feedStream(msg('m1', head + '尾巴一句。'), '尾巴一句。') // 不够门槛 → 留在缓冲
    expect(h.calls.append.length).toBe(1)
    api.turnEnd(msg('m1', head + '尾巴一句。'), true)
    expect(h.calls.append.join('')).toContain('尾巴一句')
    expect(h.calls.speak).toEqual([])
  })
})

describe('useChatSpeech 失败/中断收尾（防止按钮卡死）', () => {
  it('本轮失败 → 不朗读，且已开的流式被停掉', () => {
    const { api } = mount({ mode: () => 'always', foreground: () => true })
    api.feedStream(msg('m1', LONG), LONG)
    expect(h.calls.beginStream).toEqual(['m1'])
    api.turnEnd(msg('m1', LONG), false)
    expect(h.calls.speak).toEqual([])
    expect(h.calls.stop).toBe(1) // ← speakingId 必须归零，否则按钮永久"正在播放"
  })

  it('本轮失败时没开过流式 → 也不额外 stop（不打断别人的朗读）', () => {
    const { api } = mount({ mode: () => 'always', foreground: () => true })
    api.turnEnd(msg('m1', '内容。'), false)
    expect(h.calls.stop).toBe(0)
  })

  it('换消息（新一轮）→ 流式状态重置，按新消息重新判定', () => {
    const { api } = mount({ mode: () => 'always', foreground: () => true })
    api.feedStream(msg('m1', LONG), LONG)
    api.feedStream(msg('m2', LONG), LONG)
    expect(h.calls.beginStream).toEqual(['m1', 'm2'])
  })

  it('stopSpeech 把 speakingId 归零（否则朗读按钮永久卡在"正在播放"）', () => {
    const { api } = mount({ mode: () => 'always', foreground: () => true })
    api.feedStream(msg('m1', LONG), LONG)
    expect(api.speakingId.value).toBe('m1')
    api.stop()
    expect(h.calls.stop).toBe(1)
    expect(api.speakingId.value).toBe(null)
    // 停之后流式状态已丢弃：同一轮若还有 chunk 到来，会按"新的一轮"重新判定，
    // 而不是把残块续到已被丢弃的旧轮后面
    api.feedStream(msg('m1', LONG), LONG)
    expect(h.calls.beginStream).toEqual(['m1', 'm1'])
  })
})
