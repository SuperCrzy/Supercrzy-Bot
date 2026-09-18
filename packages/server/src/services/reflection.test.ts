/**
 * reflection.ts 的 stableTaskKey 测试（#147，2026-09-18）
 *
 * 为什么单独测一个"字符串截断"函数：它是**写入侧防膨胀的唯一支点**。
 * 原实现用 LLM 每次现场生成的 problem 当 key，同一任务跑两遍就是两个不同的 key，
 * 于是精确去重永远不触发（实测 103 条 experience 有 88 个不同 key）。
 * 这个函数一旦退化（比如又被换回模型文本、或者归一化太弱），
 * 表就会重新回到"随任务数线性膨胀"，而那种退化**不会报错**，只会静默变胖。
 * 所以在这里把"同任务必同 key""不同任务不该撞车"两端都锁住。
 */
import { describe, it, expect } from 'vitest'
import { stableTaskKey } from './reflection'

describe('stableTaskKey 任务 key 稳定性', () => {
  it('同一句话 → 恒等（去重的充分条件）', () => {
    const t = '帮我查一下今天 AI 领域的重要新闻'
    expect(stableTaskKey(t)).toBe(stableTaskKey(t))
  })

  it('空白差异不影响（多空格 / 换行 / 首尾空白 / 汉字两侧空格）—— ★核心回归点', () => {
    const base = '帮我查今天AI新闻'
    const variants = [
      `  ${base}  `,
      `帮我查今天AI新闻\n`,
      '帮我查今天  AI   新闻',
      '\n\n帮我查今天AI新闻\t',
      '帮我查今天 AI 新闻',
      '帮我查今天AI新闻 ',
    ]
    const keys = new Set(variants.map(stableTaskKey))
    expect(keys.size, `归一不一致: ${JSON.stringify([...keys])}`).toBe(1)
  })

  it('拉丁词之间的空格必须保留（合并层靠它切词元，全删会让近似合并失效）', () => {
    // 这是刻意的非对称：汉字两侧空格删、拉丁词间空格留 —— 所以 "A I" ≠ "AI"（那是两个词，不是手滑）
    expect(stableTaskKey('verify shell tool')).toBe('verify shell tool')
    expect(stableTaskKey('verify  shell   tool')).toBe('verify shell tool')
    expect(stableTaskKey('帮我查今天A I新闻')).toBe('帮我查今天A I新闻')
  })

  it('标点差异不影响（中英文标点都当分隔）', () => {
    const keys = new Set([
      stableTaskKey('帮我查今天AI新闻。'),
      stableTaskKey('帮我查今天AI新闻，'),
      stableTaskKey('帮我查今天AI新闻!'),
      stableTaskKey('帮我查今天AI新闻'),
      stableTaskKey('帮我查今天AI新闻.'),
    ])
    expect(keys.size).toBe(1)
  })

  it('长任务文本截断到 40 字符（key 有长度上限）', () => {
    expect(stableTaskKey('x'.repeat(500)).length).toBe(40)
  })

  it('不同任务不撞车（截断后仍可区分）', () => {
    const a = stableTaskKey('整理记忆系统的分类词表')
    const b = stableTaskKey('给首页加一个暗色模式开关')
    expect(a).not.toBe(b)
  })

  it('空 / 非法输入返回空串（由调用方兜底到 skillName/problem）', () => {
    expect(stableTaskKey('')).toBe('')
    expect(stableTaskKey('   \n\t ')).toBe('')
    expect(stableTaskKey('！！！？？？')).toBe('')
    expect(stableTaskKey(null as any)).toBe('')
    expect(stableTaskKey(undefined as any)).toBe('')
  })
})
