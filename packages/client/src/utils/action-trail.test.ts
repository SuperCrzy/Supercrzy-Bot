import { describe, it, expect } from 'vitest'
import { resolveTrailRows, toolDurationMs } from './action-trail'
import { resolveActiveAction, type ProcessNodeLike } from './process-view'

/** 只认 key 的翻译桩：断言的是"用了哪套措辞"，不是译文本身 */
const t = (k: string) => k

const tool = (name: string, status: string, extra: Record<string, unknown> = {}, id?: string): ProcessNodeLike => ({
  kind: 'tool',
  tool: { id, name, status, arguments: '{}', ...extra },
})

describe('resolveTrailRows', () => {
  it('只留终态：运行中/待审批的动作不进痕迹行（由状态行承担，否则同一动作出现两次）', () => {
    const nodes = [tool('file_read', 'done', {}, 'a'), tool('shell_exec', 'running', {}, 'b'), tool('web_fetch', 'pending', {}, 'c')]
    const rows = resolveTrailRows(nodes, t)
    expect(rows.map((r) => r.key)).toEqual(['tool:a'])
  })

  it('顺序 = 节点顺序（不重排、不聚合：读→改→跑的因果顺序不能藏）', () => {
    const nodes = [tool('file_read', 'done', {}, 'a'), tool('file_write', 'done', {}, 'b'), tool('shell_exec', 'done', {}, 'c')]
    expect(resolveTrailRows(nodes, t).map((r) => r.key)).toEqual(['tool:a', 'tool:b', 'tool:c'])
  })

  it('状态行正在显示的那个动作被剔除（activeKey 命中）', () => {
    const nodes = [tool('file_read', 'done', {}, 'a'), tool('shell_exec', 'done', {}, 'b')]
    const active = resolveActiveAction(nodes, t)
    const rows = resolveTrailRows(nodes, t, { activeKey: active.key })
    expect(rows.map((r) => r.key)).toEqual(['tool:a'])
  })

  it('图标走 tool-meta 注册表（不在这里另建一份名字表）', () => {
    const nodes = [tool('shell_exec', 'done', {}, 'a'), tool('file_read', 'done', {}, 'b'), tool('some_unknown_tool', 'done', {}, 'c')]
    expect(resolveTrailRows(nodes, t).map((r) => r.icon)).toEqual(['cmd', 'read', 'default'])
  })

  it('失败/取消分开标：error=失败，denied/cancelled=取消，done 两者皆否', () => {
    const nodes = [tool('file_read', 'error', {}, 'a'), tool('file_read', 'cancelled', {}, 'b'), tool('file_read', 'done', {}, 'c')]
    const rows = resolveTrailRows(nodes, t)
    expect(rows.map((r) => [r.failed, r.cancelled])).toEqual([[true, false], [false, true], [false, false]])
  })

  it('耗时：结构化 duration（秒）优先，退化用 createTime − startedAt，都没有则空串', () => {
    const nodes = [
      tool('shell_exec', 'done', { duration: 45 }, 'a'),
      tool('shell_exec', 'done', { startedAt: 1000, createTime: 8500 }, 'b'),
      tool('shell_exec', 'done', {}, 'c'),
    ]
    expect(resolveTrailRows(nodes, t).map((r) => r.duration)).toEqual(['45s', '7s', ''])
  })

  it('max 保留**最近**的 N 条（砍最早的不是最新的）', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => tool('file_read', 'done', {}, `id${i}`))
    expect(resolveTrailRows(nodes, t, { max: 3 }).map((r) => r.key)).toEqual(['tool:id3', 'tool:id4', 'tool:id5'])
  })

  it('文案不把内部工具名抛给用户（回归：若有人改回 `name` 兜底，这里立刻红）', () => {
    const nodes = [tool('shell_exec', 'done', {}, 'a'), tool('file_read', 'done', {}, 'b'), tool('web_fetch', 'done', {}, 'c')]
    for (const r of resolveTrailRows(nodes, t)) {
      expect(r.label).not.toMatch(/shell_exec|file_read|web_fetch/)
      expect(r.label.length).toBeGreaterThan(0)
    }
  })

  it('持久终端一族必须带宾语（回归：老板实测痕迹行只显示"读取"/"执行"，看不出读什么、跑什么）', () => {
    const nodes = [
      tool('terminal_open', 'done', {}, 'a'),
      tool('terminal_send', 'done', { arguments: JSON.stringify({ id: 'x1', command: 'npm test' }) }, 'b'),
      tool('terminal_read', 'done', { arguments: JSON.stringify({ id: 'x1' }) }, 'c'),
    ]
    const rows = resolveTrailRows(nodes, t)
    // 命令本身必须出现在标题里（旧行为：整族不在描述符表 ⇒ 只剩阶段名 chat.stageExec）
    expect(rows[1].label).toContain('npm test')
    expect(rows[1].label).not.toBe('chat.stageExec')
    // 读取要能看出是哪个会话
    expect(rows[2].label).toContain('x1')
    expect(rows[2].label).not.toBe('chat.stageRead')
    // 图标不再掉到扳手兜底
    expect(rows.map((r) => r.icon)).toEqual(['cmd', 'cmd', 'cmd'])
  })

  it('思考节点不产生痕迹行（只有工具动作才算"做了什么"）', () => {    const nodes: ProcessNodeLike[] = [
      { kind: 'thinking', id: 'x', completed: true },
      { kind: 'thinking-group', turns: [{ completed: true }] },
      tool('file_read', 'done', {}, 'a'),
    ]
    expect(resolveTrailRows(nodes, t)).toHaveLength(1)
  })

  it('空输入不抛', () => {
    expect(resolveTrailRows([], t)).toEqual([])
  })
})

describe('toolDurationMs', () => {
  it('duration 单位是秒 → 毫秒；createTime 缺失/倒挂不产生负值', () => {
    expect(toolDurationMs({ duration: 3 })).toBe(3000)
    expect(toolDurationMs({ startedAt: 5000, createTime: 1000 })).toBe(0)
    expect(toolDurationMs(undefined)).toBe(0)
  })
})
