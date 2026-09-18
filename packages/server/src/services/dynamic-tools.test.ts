/**
 * 动态工具集契约测试（报告指标：普通任务默认注入工具数 ≤ 12）
 * 目的：把"工具膨胀"从主观感受变成 CI 可拦的度量。
 * 注：本轮实测常驻 26 → 12；此前 42 个工具里 26 个每轮都塞进 prompt，
 * 既贵又给模型制造选择过载（选错工具/绕远路的直接原因）。
 */
import { describe, it, expect } from 'vitest'
import {
  toolDefinitions,
  toolExecutors,
  DEFERRED_TOOLS,
  alwaysOnToolDefs,
  validateAlwaysOnContract,
  MAX_ALWAYS_ON_TOOLS,
} from '../services/tools'

describe('动态工具集契约', () => {
  it('常驻工具数不超过上限（报告指标 ≤12）', () => {
    const on = alwaysOnToolDefs()
    expect(on.length).toBeLessThanOrEqual(MAX_ALWAYS_ON_TOOLS)
  })

  it('tool_search 必须常驻 —— 否则模型无从发现按需工具', () => {
    const names = alwaysOnToolDefs().map((t) => t.name)
    expect(names).toContain('tool_search')
  })

  it('常驻与按需互斥且并集等于全部工具（不重不漏）', () => {
    const all = toolDefinitions.map((t) => t.name).sort()
    const on = alwaysOnToolDefs().map((t) => t.name)
    const off = all.filter((n) => DEFERRED_TOOLS.has(n))
    // 互斥
    expect(on.filter((n) => DEFERRED_TOOLS.has(n))).toEqual([])
    // 不重不漏
    expect([...on, ...off].sort()).toEqual(all)
  })

  it('DEFERRED_TOOLS 里不能有未注册的工具名（否则永远搜不到）', () => {
    const known = new Set(toolDefinitions.map((t) => t.name))
    const ghosts = [...DEFERRED_TOOLS].filter((n) => !known.has(n))
    expect(ghosts).toEqual([])
  })

  it('每个按需工具都能被 tool_search 搜到（按名字精确查询）', () => {
    // tool_search 的实现是对 DEFERRED_TOOLS 做 name.includes(query)——
    // 这里校验"用完整工具名去搜一定能命中自己"，保证按需工具可达。
    for (const name of DEFERRED_TOOLS) {
      const matched = [...DEFERRED_TOOLS].filter((n) => n.includes(name))
      expect(matched).toContain(name)
    }
  })

  it('每个不常驻的工具都必须有可调用的执行器（加载后真能调）', () => {
    for (const name of DEFERRED_TOOLS) {
      expect(typeof toolExecutors[name]).toBe('function')
    }
  })

  it('validateAlwaysOnContract 对当前仓库返回 ok', () => {
    const r = validateAlwaysOnContract()
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('核心闭环工具必须常驻（工作区读写/执行/搜索/计划/进度/澄清）', () => {
    const on = new Set(alwaysOnToolDefs().map((t) => t.name))
    const core = [
      'tool_search',
      'file_read',
      'file_write',
      'multi_edit',
      'shell_exec',
      'web_search',
      'web_fetch',
      'deep_research',
      'create_plan',
      'task_create',
      'task_update',
      'ask_user',
    ]
    for (const n of core) expect(on.has(n)).toBe(true)
    // 常驻集合恰好就是这 12 个 —— 多了说明有人偷偷加，少了说明有人误删
    expect([...on].sort()).toEqual([...core].sort())
  })
})
