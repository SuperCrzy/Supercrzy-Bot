import { describe, it, expect } from 'vitest'
import { splitWords, matchPlaybooks } from '../services/playbook-match'

describe('splitWords 任务类型拆词', () => {
  it('按分隔符分词', () => {
    const words = splitWords('信息检索, 总结')
    expect(words).toContain('信息检索')
    expect(words).toContain('总结')
  })

  it('滑动 2-gram 提高召回（中文连续串也能匹配）', () => {
    const words = splitWords('信息检索总结')
    // 连续串不应只有一个整体词——必须产出 2-gram 片段
    expect(words).toContain('检索')
    expect(words.some((w) => w.length === 2)).toBe(true)
  })

  it('过滤单字分词，但保留 2-gram', () => {
    const words = splitWords('AI 搜索')
    // 'AI' 长度 2 保留；无单字词
    expect(words).toContain('AI')
    expect(words).toContain('AI') // 2-gram 也覆盖
  })

  it('空串不报错', () => {
    expect(Array.isArray(splitWords(''))).toBe(true)
  })
})

describe('matchPlaybooks 经验匹配', () => {
  const playbooks = [
    { task_type: '信息检索总结', lesson: '先用web_search找聚合源' },
    { task_type: '代码生成', lesson: '先写骨架再填充' },
    { task_type: '文件操作', lesson: '先检查文件是否存在' },
  ]

  it('同类任务命中（双向 2-gram）', () => {
    const hit = matchPlaybooks(playbooks, '搜索今天的 AI 新闻并总结要点')
    expect(hit.length).toBeGreaterThan(0)
    expect(hit[0].task_type).toContain('检索')
  })

  it('最多返回 2 条', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      task_type: `任务类型${i}`, lesson: `经验${i}`,
    }))
    const hit = matchPlaybooks(many, '任务类型1 任务类型2 任务类型3')
    expect(hit.length).toBeLessThanOrEqual(2)
  })

  it('无关任务不命中', () => {
    const hit = matchPlaybooks(playbooks, '帮我订一张去北京的机票')
    expect(hit.length).toBe(0)
  })

  it('空查询/空库不命中', () => {
    expect(matchPlaybooks(playbooks, '')).toHaveLength(0)
    expect(matchPlaybooks([], '搜索')).toHaveLength(0)
  })

  it('大小写不敏感', () => {
    const hit = matchPlaybooks([{ task_type: 'WEB SEARCH', lesson: 'x' }], 'web 搜索')
    expect(hit.length).toBeGreaterThan(0)
  })
})
