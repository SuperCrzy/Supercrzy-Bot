/**
 * 统一过程阶段单测（P1-02）
 */
import { describe, it, expect } from 'vitest'
import {
  stageOfTool,
  stageBreakdown,
  formatStageBreakdown,
  STAGE_ORDER,
  STAGE_I18N,
  type AgentStage,
} from './stage'
import type { ChatFlowNode } from '@/types'

/** 当前全部 42 个工具（与 server scripts/validate-tools.ts 实测一致） */
const ALL_TOOLS = [
  'ask_question', 'ask_user', 'browser', 'computer_use', 'create_plan', 'deep_research',
  'draw_diagram', 'file_delete', 'file_exists', 'file_read', 'file_write', 'generate_image',
  'get_goal', 'git_commit', 'git_diff', 'git_status', 'lint_file', 'make_article',
  'memory_list', 'memory_recall', 'memory_store', 'multi_edit', 'news_search', 'read_me',
  'shell_exec', 'skill_install', 'skill_list', 'skill_search', 'skill_view', 'task_create',
  'task_list', 'task_update', 'terminal_close', 'terminal_list', 'terminal_open',
  'terminal_read', 'terminal_send', 'terminal_signal', 'tool_search', 'video_edit',
  'web_fetch', 'web_search',
]

describe('阶段定义', () => {
  it('恰好 7 个阶段，且每阶段都有 i18n key', () => {
    expect(STAGE_ORDER.length).toBe(7)
    for (const s of STAGE_ORDER) expect(STAGE_I18N[s]).toMatch(/^chat\.stage/)
  })
})

describe('工具 → 阶段', () => {
  it('全部 42 个工具都能映射到合法阶段', () => {
    for (const name of ALL_TOOLS) {
      expect(STAGE_ORDER).toContain(stageOfTool(name))
    }
  })

  it('关键映射符合用户直觉', () => {
    expect(stageOfTool('file_read')).toBe('reading')
    expect(stageOfTool('web_search')).toBe('searching')
    expect(stageOfTool('web_fetch')).toBe('searching')
    expect(stageOfTool('file_write')).toBe('editing')
    expect(stageOfTool('multi_edit')).toBe('editing')
    expect(stageOfTool('draw_diagram')).toBe('generating')
    expect(stageOfTool('generate_image')).toBe('generating')
    expect(stageOfTool('lint_file')).toBe('verifying')
    expect(stageOfTool('shell_exec')).toBe('executing')
    expect(stageOfTool('create_plan')).toBe('analyzing')
    expect(stageOfTool('ask_user')).toBe('analyzing')
  })

  it('绝不返回原始工具名（用户不该看到内部标识）', () => {
    for (const name of ALL_TOOLS) {
      expect(stageOfTool(name)).not.toBe(name)
    }
  })

  it('未知工具回退到 executing，而不是泄漏名字或崩溃', () => {
    expect(stageOfTool('totally_new_tool')).toBe('executing')
    expect(stageOfTool('')).toBe('executing')
    expect(stageOfTool(undefined as unknown as string)).toBe('executing')
  })

  it('前缀兜底对未登记的新工具生效', () => {
    expect(stageOfTool('file_read_v2')).toBe('reading')
    expect(stageOfTool('web_crawl')).toBe('searching')
    expect(stageOfTool('lint_repo')).toBe('verifying')
  })
})

describe('阶段统计', () => {
  const node = (name: string): ChatFlowNode => ({ kind: 'tool', tool: { name } } as unknown as ChatFlowNode)

  it('按固定顺序返回，只含出现过的阶段', () => {
    const nodes = [
      node('file_write'),
      node('file_read'),
      node('file_read'),
      node('lint_file'),
      node('shell_exec'),
    ]
    const got = stageBreakdown(nodes)
    expect(got).toEqual([
      { stage: 'reading', count: 2 },
      { stage: 'editing', count: 1 },
      { stage: 'verifying', count: 1 },
      { stage: 'executing', count: 1 },
    ])
    // 顺序必须与 STAGE_ORDER 一致
    const order = got.map((g) => STAGE_ORDER.indexOf(g.stage))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('忽略非 tool 节点（thinking / text 不是阶段动作）', () => {
    const nodes = [
      { kind: 'thinking' } as unknown as ChatFlowNode,
      { kind: 'text' } as unknown as ChatFlowNode,
      node('file_read'),
    ]
    expect(stageBreakdown(nodes)).toEqual([{ stage: 'reading', count: 1 }])
  })

  it('空输入返回空数组', () => {
    expect(stageBreakdown(undefined)).toEqual([])
    expect(stageBreakdown([])).toEqual([])
  })
})

describe('阶段摘要渲染', () => {
  const fakeT = (key: string, params?: Record<string, unknown>) =>
    key === 'chat.stageCount' ? `${params?.stage} ${params?.n}` : key

  it('最多取前 3 项，避免又变成一串数字', () => {
    const counts = STAGE_ORDER.map((s: AgentStage) => ({ stage: s, count: 1 }))
    const out = formatStageBreakdown(counts, fakeT)
    expect(out.split(' · ').length).toBe(3)
  })

  it('正常渲染为"读取 2 · 编辑 1"', () => {
    const out = formatStageBreakdown(
      [{ stage: 'reading', count: 2 }, { stage: 'editing', count: 1 }],
      fakeT,
    )
    expect(out).toBe('chat.stageReading 2 · chat.stageEditing 1')
  })

  it('空统计返回空串（调用方据此退回原计数）', () => {
    expect(formatStageBreakdown([], fakeT)).toBe('')
  })
})
