import { describe, it, expect } from 'vitest'
import {
  resolveActiveAction,
  resolveTrail,
  resolveCounter,
  actionStat,
  TERMINAL_TOOL_STATUSES,
  type ProcessNodeLike,
} from './process-view'

/** 真实语言包片段（与 i18n/index.ts 的 zh-CN 值一致，改动 key 值这里会一起暴露） */
const DICT: Record<string, string> = {
  'chat.thinking': '正在思考...',
  'chat.processCollapsed': '执行过程',
  'chat.procPending': '待确认',
  'chat.procLines': '{done}/{total} 行',
  'chat.procEdits': '{done}/{count} 处',
  'chat.processRunning': '正在{action}',
  'chat.procVerbCreate': '创建',
  'chat.procVerbEdit': '编辑',
  'chat.statusWorking': '正在处理',
  // tool-summary 动词表（用到哪几个写哪几个）
  'chat.sumRead': '读取',
  'chat.sumWrite': '写入',
  'chat.sumWebFetch': '读取网页',
  'chat.sumCmd': '运行命令',
  'chat.sumFallback': '处理',
  // stage 名词表
  'chat.stageAnalyzing': '分析',
  'chat.stageReading': '读取',
  'chat.stageSearching': '搜索',
  'chat.stageEditing': '编辑',
  'chat.stageGenerating': '生成',
  'chat.stageVerifying': '验证',
  'chat.stageExecuting': '执行',
}

function t(key: string, params?: Record<string, unknown>): string {
  const raw = DICT[key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`))
}

const think = (id: string, completed: boolean): ProcessNodeLike => ({ kind: 'thinking', id, completed })
const tool = (id: string, name: string, status: string, args = '{}'): ProcessNodeLike => ({
  kind: 'tool',
  tool: { id, name, status, arguments: args },
})

describe('resolveActiveAction（单行状态行·当前动作判定）', () => {
  it('空段 → 兜底，不崩、不吐内部工具名', () => {
    const a = resolveActiveAction([], t)
    expect(a.key).toBe('none')
    expect(a.label).toBe('执行过程')
    expect(a.running).toBe(false)
  })

  it('未完成的思考优先于已终态工具（思考在最右且在跑）', () => {
    const a = resolveActiveAction([tool('t1', 'file_read', 'done'), think('k1', false)], t)
    expect(a.key).toBe('think:k1')
    expect(a.label).toBe('正在思考...')
    expect(a.running).toBe(true)
  })

  it('执行中的文件工具 → "正在" + 阶段动词 + basename（路径不显全）', () => {
    const a = resolveActiveAction([tool('t1', 'file_read', 'running', '{"file_path":"src/utils/a.ts"}')], t)
    expect(a.key).toBe('tool:t1')
    expect(a.label).toBe('正在读取')
    expect(a.target).toBe('a.ts')
    expect(a.running).toBe(true)
    expect(a.pending).toBe(false)
  })

  it('文件写入：phase=create → "正在创建"，phase=edit → "正在编辑"（动词随新旧文件动态推导）', () => {
    const create = resolveActiveAction([tool('t1', 'file_write', 'running', '{"path":"/a/b/C.vue"}')], t)
    // 首帧（progress 未到）退到阶段名"编辑"——不能凭工具名断言"创建"（file_write 也用于覆盖已有文件）
    expect(create.label).toBe('正在编辑')
    const withCreate = resolveActiveAction(
      [{ ...tool('t1', 'file_write', 'running', '{"path":"/a/b/C.vue"}'), tool: { id: 't1', name: 'file_write', status: 'running', arguments: '{"path":"/a/b/C.vue"}', progress: { phase: 'create' } } }],
      t,
    )
    expect(withCreate.label).toBe('正在创建')
    expect(withCreate.target).toBe('C.vue')
    const withEdit = resolveActiveAction(
      [{ ...tool('t2', 'file_write', 'done', '{"path":"/a/b/C.vue"}'), tool: { id: 't2', name: 'file_write', status: 'done', arguments: '{"path":"/a/b/C.vue"}', progress: { phase: 'edit' } } }],
      t,
    )
    expect(withEdit.label).toBe('编辑') // 完成态去掉"正在"
    expect(withEdit.target).toBe('C.vue')
  })

  it('绝对路径只显示 basename（单行放不下 80+ 字符的路径）', () => {
    const a = resolveActiveAction(
      [tool('t1', 'multi_edit', 'running', '{"file_path":"/Users/x/Downloads/proj/packages/client/src/components/chat/ProcessStatusLine.vue"}')],
      t,
    )
    expect(a.target).toBe('ProcessStatusLine.vue')
    expect(a.label).toBe('正在编辑')
  })

  it('非文件工具的宾语保持原样（URL/命令不截成 basename）', () => {
    const a = resolveActiveAction([tool('t1', 'web_fetch', 'running', '{"url":"https://example.com/a/b"}')], t)
    expect(a.label).toBe('正在读取网页 https://example.com/a/b')
    expect(a.target).toBe('')
  })

  it('pending → 措辞改为「待确认」，且仍算 running（未终态）', () => {
    const a = resolveActiveAction([tool('t1', 'file_write', 'pending', '{"path":"a.ts"}')], t)
    expect(a.label).toBe('待确认')
    expect(a.pending).toBe(true)
    expect(a.running).toBe(true)
  })

  it('并行同名工具：取最右侧**非终态**，而不是最右侧（末尾已终态）', () => {
    const nodes = [tool('a', 'file_read', 'running'), tool('b', 'file_read', 'done')]
    const a = resolveActiveAction(nodes, t)
    expect(a.key).toBe('tool:a')
    expect(a.running).toBe(true)
  })

  it('全部终态 → 显示最后一个动作，running=false（且去掉"正在"前缀）', () => {
    const a = resolveActiveAction([tool('a', 'file_read', 'done'), tool('b', 'shell_exec', 'done', '{"command":"ls"}')], t)
    expect(a.key).toBe('tool:b')
    expect(a.running).toBe(false)
    expect(a.label).toBe('运行命令 ls')
    expect(a.label).not.toContain('正在')
  })

  it('无宾语的工具退到阶段名，绝不吐内部工具名', () => {
    const a = resolveActiveAction([tool('a', 'browser', 'running')], t)
    expect(a.label).toBe('正在执行')
    expect(a.label).not.toContain('browser')
  })

  it('只有 thinking 且已完成 → 思考态收尾（running=false）', () => {
    const a = resolveActiveAction([think('k1', true)], t)
    expect(a.key).toBe('think:k1')
    expect(a.running).toBe(false)
  })

  it('无 id 的节点：key 回退到下标，仍稳定可判等', () => {
    const nodes: ProcessNodeLike[] = [{ kind: 'tool', tool: { name: 'file_read', status: 'running', arguments: '{}' } }]
    expect(resolveActiveAction(nodes, t).key).toBe('tool:0')
    expect(resolveActiveAction(nodes, t).key).toBe('tool:0')
  })

  it('终态集合与 agent-flow / MessageFlowRenderer 同口径（含 destroyed）', () => {
    for (const s of ['done', 'error', 'denied', 'cancelled', 'skipped', 'destroyed']) {
      expect(TERMINAL_TOOL_STATUSES.has(s)).toBe(true)
      expect(resolveActiveAction([tool('x', 'file_read', s)], t).running).toBe(false)
    }
  })
})

describe('actionStat / resolveTrail（进度痕迹）', () => {
  it('thinking-group 折算成 turns.length 个动作', () => {
    expect(actionStat({ kind: 'thinking-group', turns: [{}, {}, {}] })).toEqual({ total: 3, done: 3 })
  })

  it('≤1 个动作 → 不画痕迹（单动作没有"痕迹"可言）', () => {
    expect(resolveTrail([tool('a', 'file_read', 'running')]).show).toBe(false)
    expect(resolveTrail([]).show).toBe(false)
  })

  it('3 个动作（2 完成 1 进行）→ 3 个圆点、2 个实心', () => {
    const v = resolveTrail([tool('a', 'file_read', 'done'), think('k', true), tool('b', 'file_write', 'running')])
    expect(v).toMatchObject({ show: true, dots: 3, done: 2, fraction: '' })
  })

  it('>6 个动作 → 退化 done/total，不画点', () => {
    const nodes: ProcessNodeLike[] = Array.from({ length: 7 }, (_, i) => tool(`t${i}`, 'file_read', 'done'))
    const v = resolveTrail(nodes)
    expect(v).toMatchObject({ show: true, dots: 0, done: 7, fraction: '7/7' })
  })

  it('恰好 6 个 → 仍画点（边界：>6 才退化）', () => {
    const nodes: ProcessNodeLike[] = Array.from({ length: 6 }, (_, i) => tool(`t${i}`, 'file_read', 'done'))
    expect(resolveTrail(nodes)).toMatchObject({ dots: 6, done: 6, fraction: '' })
  })
})

describe('resolveCounter（实时数字）', () => {
  it('无进度 → 不显示', () => {
    expect(resolveCounter(undefined, t).show).toBe(false)
    expect(resolveCounter({}, t).show).toBe(false)
    expect(resolveCounter({ added: 0, deleted: 0 }, t).show).toBe(false)
  })

  it('写入类 → 只显 ± 增删（2026-09-25 老板定稿「+10 -1」格式；2026-09-26 百分比试验已撤）', () => {
    const v = resolveCounter({ added: 12, deleted: 3, done: 30, total: 100, phase: 'create' }, t)
    expect(v).toMatchObject({ show: true, added: 12, deleted: 3, frac: '' })
  })

  it('多处编辑类 → 显累计 ±（cumAdded/cumDeleted 语义正确，处数分数已废）', () => {
    const v = resolveCounter({ added: 4, deleted: 3, done: 2, count: 5, phase: 'edit' }, t)
    expect(v).toMatchObject({ show: true, added: 4, deleted: 3, frac: '' })
  })

  it('只有 ± 没有分数 → 仍显示 ±', () => {
    const v = resolveCounter({ added: 7, deleted: 0 }, t)
    expect(v).toMatchObject({ show: true, added: 7, deleted: 0, frac: '' })
  })
})
