/**
 * 客户端进度数据管线（G5/I13，2026-09-24）。
 *
 * 这一层的价值：单测 `process-view` 只证明"给定进度能算出正确视图"，
 * 单测服务端只证明"能发出正确载荷"——**两段之间靠 `tool_progress` 事件的字段形状对接**，
 * 而那正是最容易脱钩的地方（一边改字段名，两边单测都还是绿的）。
 * 这里用**服务端真实载荷形状**（从 `file-write.ts` / `multi-edit.ts` 的 `ctx.onProgress` 抄下来）
 * 喂进客户端处理器，断言端到端算出的状态行文案/数字。
 */
import { describe, it, expect } from 'vitest'
import { applyToolArgsChunk, applyToolProgress, applyToolResult, extractToolTarget } from './agent-flow'
import { resolveActiveAction, resolveCounter, resolveTrail } from './process-view'
import type { ChatMessage } from '@/types'

const DICT: Record<string, string> = {
  'chat.thinking': '正在思考...',
  'chat.processCollapsed': '执行过程',
  'chat.procPending': '待确认',
  'chat.procLines': '{done}/{total} 行',
  'chat.procEdits': '{done}/{count} 处',
  'chat.processRunning': '正在{action}',
  'chat.procVerbCreate': '创建',
  'chat.procVerbEdit': '编辑',
  'chat.procError': '执行出错',
  'chat.procCancelled': '已取消',
  'chat.procAggRead': '正在查找相关文件 · 第 {n} 个',
  'chat.stageReading': '读取',
  'chat.shellTest': '正在跑测试',
  'chat.shellBuild': '正在构建',
  'chat.shellRun': '正在运行脚本',
  'chat.shellGitView': '正在查看版本状态',
  'chat.sumCmd': '运行命令',
  'chat.sumRead': '读取',
  'chat.statusWorking': '正在处理',
  'chat.sumWrite': '写入',
  'chat.stageEditing': '编辑',
  'chat.stageExecuting': '执行',
}
function t(key: string, params?: Record<string, unknown>): string {
  const raw = DICT[key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`))
}

function emptyMsg(): ChatMessage {
  return { id: 'm1', role: 'assistant', content: '', flow: [] } as unknown as ChatMessage
}
const nodeOf = (m: ChatMessage) => (m.flow || [])[0] as any

describe('applyToolProgress（SSE tool_progress → 节点）', () => {
  it('按 toolCallId 落到对应节点，且**剥掉 toolCallId/name**不进 progress', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'call_1', name: 'file_write', chunk: '{"path":"/a/b/C.vue"}' })
    applyToolProgress(m, { toolCallId: 'call_1', name: 'file_write', added: 12, deleted: 0, done: 12, total: 61, phase: 'create' })
    expect(nodeOf(m).tool.progress).toEqual({ added: 12, deleted: 0, done: 12, total: 61, phase: 'create' })
    expect(Object.keys(nodeOf(m).tool.progress)).not.toContain('toolCallId')
  })

  it('多块进度**合并覆盖**（不同工具只报字段子集：multi_edit 的 count 不被后续无 count 载荷清掉）', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'c1', name: 'multi_edit', chunk: '{}' })
    applyToolProgress(m, { toolCallId: 'c1', done: 1, count: 3, phase: 'edit' })
    applyToolProgress(m, { toolCallId: 'c1', done: 2 })
    expect(nodeOf(m).tool.progress).toEqual({ done: 2, count: 3, phase: 'edit' })
  })

  it('pending → running（进度到达即认为工具已开跑）', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'c1', name: 'file_write', chunk: '{}' })
    nodeOf(m).tool.status = 'pending'
    applyToolProgress(m, { toolCallId: 'c1', done: 1, total: 5 })
    expect(nodeOf(m).tool.status).toBe('running')
  })

  it('toolCallId 匹配失败 → 不新建节点、不崩（进度是可选增强，不该污染 flow）', () => {
    const m = emptyMsg()
    applyToolProgress(m, { toolCallId: 'nope', added: 3 })
    expect(m.flow).toEqual([])
  })
})

describe('服务端载荷 → 状态行（端到端对接）', () => {
  it('file_write 新建：载荷形状 → "正在创建 C.vue +61 61/61 行"', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'call_w', name: 'file_write', chunk: '{"path":"/Users/x/p/C.vue","content":"…"}' })
    // 逐块推进（形状照抄 file-write.ts 的 ctx.onProgress）
    for (const [added, done] of [[12, 12], [36, 36], [61, 61]] as const) {
      applyToolProgress(m, { toolCallId: 'call_w', added, deleted: 0, done, total: 61, phase: 'create' })
    }
    const a = resolveActiveAction(m.flow || [], t)
    expect(a.label).toBe('正在创建')
    expect(a.target).toBe('C.vue')
    expect(a.running).toBe(true)
    const c = resolveCounter(nodeOf(m).tool.progress, t)
    expect(c).toMatchObject({ show: true, added: 61, deleted: 0, frac: '' })
  })

  it('file_write 改已有文件：phase=edit → "正在编辑"，± 都显', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'call_w', name: 'file_write', chunk: '{"path":"/Users/x/p/a.ts"}' })
    applyToolProgress(m, { toolCallId: 'call_w', added: 40, deleted: 12, done: 100, total: 351, phase: 'edit' })
    const a = resolveActiveAction(m.flow || [], t)
    expect(a.label).toBe('正在编辑')
    expect(a.target).toBe('a.ts')
    expect(resolveCounter(nodeOf(m).tool.progress, t)).toMatchObject({ added: 40, deleted: 12, frac: '' })
  })

  it('multi_edit：→ "正在编辑 x.ts +4 −3"（2026-09-25 老板定稿 ± 格式，处数分数已废）', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'call_m', name: 'multi_edit', chunk: '{"file_path":"/Users/x/p/x.ts"}' })
    applyToolProgress(m, { toolCallId: 'call_m', added: 4, deleted: 3, done: 2, count: 3, phase: 'edit' })
    const a = resolveActiveAction(m.flow || [], t)
    expect(a.label).toBe('正在编辑')
    expect(a.target).toBe('x.ts')
    expect(resolveCounter(nodeOf(m).tool.progress, t)).toMatchObject({ show: true, added: 4, deleted: 3, frac: '' })
  })

  it('结果到达（tool_result）→ 动作收尾：去掉"正在"，trail 记满', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'call_w', name: 'file_write', chunk: '{"path":"/a/C.vue"}' })
    applyToolProgress(m, { toolCallId: 'call_w', added: 61, deleted: 0, done: 61, total: 61, phase: 'create' })
    applyToolResult(m, { tool_call_id: 'call_w', content: '✅ 文件已创建：/a/C.vue (1 字符, 61 行)' })
    const a = resolveActiveAction(m.flow || [], t)
    expect(a.running).toBe(false)
    expect(a.label).toBe('创建')
    expect(a.target).toBe('C.vue')
    expect(resolveTrail(m.flow || [])).toMatchObject({ show: false, done: 1 }) // 单动作 → 不画痕迹
  })

  it('工具出错：label → "执行出错" + failed 标记（不再落进绿勾完成态）', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'c9', name: 'file_read', chunk: '{"file_path":"/a/x.ts"}' })
    applyToolResult(m, { tool_call_id: 'c9', status: 'error', content: 'boom' })
    const a = resolveActiveAction(m.flow || [], t)
    expect(a.label).toBe('执行出错')
    expect(a.failed).toBe(true)
    expect(a.running).toBe(false)
  })

  it('工具被拒/取消：label → "已取消" + cancelled 标记', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'c8', name: 'shell_exec', chunk: '{"command":"rm /tmp/x"}' })
    applyToolResult(m, { tool_call_id: 'c8', status: 'denied', content: 'denied' })
    const a = resolveActiveAction(m.flow || [], t)
    expect(a.label).toBe('已取消')
    expect(a.cancelled).toBe(true)
  })

  it('pill 智能化①：shell 命令 → 意图转译（npm test / git status / && 链取末段），查不到兜底原摘要', () => {
    const m1 = emptyMsg()
    applyToolArgsChunk(m1, { toolCallId: 's1', name: 'shell_exec', chunk: '{"command":"npm test"}' })
    expect(resolveActiveAction(m1.flow || [], t).label).toBe('正在跑测试')
    const m2 = emptyMsg()
    applyToolArgsChunk(m2, { toolCallId: 's2', name: 'shell_exec', chunk: '{"command":"cd /a && git status"}' })
    expect(resolveActiveAction(m2.flow || [], t).label).toBe('正在查看版本状态')
    const m3 = emptyMsg()
    applyToolArgsChunk(m3, { toolCallId: 's3', name: 'shell_exec', chunk: '{"command":"./weird-binary --flag"}' })
    const a3 = resolveActiveAction(m3.flow || [], t)
    expect(a3.label).not.toBe('正在跑测试')
  })

  it('pill 智能化④：file_read 连续 ≥2 → 聚合「正在查找相关文件 · 第 N 个」（思考不断链，其他工具断链）', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'r1', name: 'file_read', chunk: '{"file_path":"/a/1.ts"}' })
    applyToolResult(m, { tool_call_id: 'r1', content: 'ok' })
    applyToolArgsChunk(m, { toolCallId: 'r2', name: 'file_read', chunk: '{"file_path":"/a/2.ts"}' })
    applyToolResult(m, { tool_call_id: 'r2', content: 'ok' })
    // 第二轮 thinking 夹在中间：不断链
    ;(m.flow || []).push({ kind: 'thinking', turn: 2, message: 'x', reasoning: '', completed: true } as any)
    applyToolArgsChunk(m, { toolCallId: 'r3', name: 'file_read', chunk: '{"file_path":"/a/3.ts"}' })
    const a = resolveActiveAction(m.flow || [], t)
    expect(a.label).toBe('正在查找相关文件 · 第 3 个')
    expect(a.target).toBe('3.ts')
  })

  it('阅读动作只出现 1 次 → 不聚合（保留原动词）', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'r1', name: 'file_read', chunk: '{"file_path":"/a/1.ts"}' })
    const a = resolveActiveAction(m.flow || [], t)
    expect(a.label).toBe('正在读取')
    expect(a.label).not.toContain('第')
  })

  it('多动作推进：圆点痕迹随终态递增（3 个动作 → 3 点 2 实心）', () => {    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'c1', name: 'file_read', chunk: '{"file_path":"/a/a.ts"}' })
    applyToolResult(m, { tool_call_id: 'c1', content: 'ok' })
    applyToolArgsChunk(m, { toolCallId: 'c2', name: 'web_fetch', chunk: '{"url":"https://x.com"}' })
    applyToolResult(m, { tool_call_id: 'c2', content: 'ok' })
    applyToolArgsChunk(m, { toolCallId: 'c3', name: 'file_write', chunk: '{"path":"/a/b.ts"}' })
    // 第三个仍在跑
    expect(resolveTrail(m.flow || [])).toMatchObject({ show: true, dots: 3, done: 2 })
  })
})

describe('生成期实时 ±（diffArgsLive，对齐 WorkBuddy useLiveChangeStats）', () => {
  it('file_write：args 逐 chunk 喂入 → progress.added 单调不减，中文/空行按行计', () => {
    const m = emptyMsg()
    const chunks = [
      '{"file_path":"/a/snake.html","content":"<!DOCTYPE html>\\n<html>\\n<body>\\n', // 3 行
      '<h1>你好世界</h1>\\n\\n\\n', // +3 → 6（含 2 个空行）
      '<canvas id=\\"c\\"></canvas>\\n</body>\\n</html>\\n"}', // +3 → 9（含转义引号）
    ]
    const seen: number[] = []
    for (const c of chunks) {
      applyToolArgsChunk(m, { toolCallId: 'w', name: 'file_write', chunk: c })
      seen.push(nodeOf(m).tool.progress?.added || 0)
    }
    expect(seen).toEqual([3, 6, 9])
    expect(nodeOf(m).tool.progress?.live).toBe(true)
    // 端到端：PSL 动作已带文件名 + 实时 ±
    const a = resolveActiveAction(m.flow || [], t)
    expect(a.target).toBe('snake.html')
    expect(resolveCounter(nodeOf(m).tool.progress, t)).toMatchObject({ show: true, added: 9, deleted: 0 })
  })

  it('转义语义：\\\\n 是字面反斜杠+n 不换行；真换行终结行，尾行闭合时补计', () => {
    const m1 = emptyMsg()
    applyToolArgsChunk(m1, { toolCallId: 'w', name: 'file_write', chunk: '{"content":"a\\\\nb"}' })
    expect(nodeOf(m1).tool.progress?.added).toBe(1) // 无换行，闭合补计 1 行
    // 流式未闭合：a\nb\nc → 尾行未终结只算 2；闭合 chunk 到达 → 补计尾行 = 3（单调）
    const m2 = emptyMsg()
    applyToolArgsChunk(m2, { toolCallId: 'w', name: 'file_write', chunk: '{"content":"a\\nb\\nc' })
    expect(nodeOf(m2).tool.progress?.added).toBe(2)
    applyToolArgsChunk(m2, { toolCallId: 'w', name: 'file_write', chunk: '"}' })
    expect(nodeOf(m2).tool.progress?.added).toBe(3)
  })

  it('空 content / 纯路径 chunk → 不写估算（show 不误亮）', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'w', name: 'file_write', chunk: '{"path":"/a/b.ts"}' })
    applyToolArgsChunk(m, { toolCallId: 'w', name: 'file_write', chunk: ',"content":""}' })
    expect(nodeOf(m).tool.progress).toBeUndefined()
  })

  it('multi_edit：new_str 计 +、old_str 计 −（两处编辑跨 chunk）', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, {
      toolCallId: 'e',
      name: 'multi_edit',
      chunk: '{"file_path":"/a/x.ts","edits":[{"old_str":"const a = 1\\nconst b = 2\\n","new_str":"const a = 0\\n"},',
    })
    expect(nodeOf(m).tool.progress).toMatchObject({ added: 1, deleted: 2, live: true })
    applyToolArgsChunk(m, { toolCallId: 'e', name: 'multi_edit', chunk: '{"old_str":"foo\\n","new_str":"bar\\nbaz\\n"}]}' })
    expect(nodeOf(m).tool.progress).toMatchObject({ added: 3, deleted: 3 })
  })

  it('server 真值（tool_progress）到达 → 覆盖估算值且 live 标记清除', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'w', name: 'file_write', chunk: '{"content":"a\\nb\\nc\\n"}' })
    expect(nodeOf(m).tool.progress?.live).toBe(true)
    applyToolProgress(m, { toolCallId: 'w', added: 9, deleted: 2, done: 9, total: 9, phase: 'edit' })
    expect(nodeOf(m).tool.progress).toEqual({ added: 9, deleted: 2, done: 9, total: 9, phase: 'edit' })
    expect(Object.keys(nodeOf(m).tool.progress)).not.toContain('live')
  })

  it('拒绝/取消/失败：估算值不残留（没有真值就不该有数字）', () => {
    const m = emptyMsg()
    applyToolArgsChunk(m, { toolCallId: 'w', name: 'file_write', chunk: '{"content":"a\\nb\\nc\\n"}' })
    expect(nodeOf(m).tool.progress?.added).toBe(3)
    applyToolResult(m, { tool_call_id: 'w', status: 'denied', content: 'denied by user' })
    expect(nodeOf(m).tool.progress?.added).toBeUndefined()
    expect(nodeOf(m).tool.progress?.deleted).toBeUndefined()
    expect(nodeOf(m).tool.progress?.live).toBeUndefined()
  })
})

describe('extractToolTarget 流式兜底（文件名实时显示）', () => {
  it('JSON 未闭合 → 前缀正则取到完整路径', () => {
    expect(extractToolTarget('file_write', '{"file_path":"/Users/x/p/snake.html","content":"<ht')).toBe(
      '/Users/x/p/snake.html',
    )
  })
  it('路径自身写到一半 → 返回已到前缀（随 chunk 到齐变完整）', () => {
    expect(extractToolTarget('multi_edit', '{"file_path":"/a/sna')).toBe('/a/sna')
  })
  it('路径含转义引号 → 正确反解', () => {
    expect(extractToolTarget('file_write', '{"file_path":"/a/b\\"c/x.ts"}')).toBe('/a/b"c/x.ts')
  })
  it('完整 JSON（轮末 tool_call）→ 仍走 JSON.parse 原路径', () => {
    expect(extractToolTarget('file_write', '{"path":"/a/b/C.vue"}')).toBe('/a/b/C.vue')
    expect(extractToolTarget('multi_edit', '{"file_path":"/a/x.ts","edits":[]}')).toBe('/a/x.ts')
  })
  it('非文件类工具不受兜底影响（解析失败返回空串）', () => {
    expect(extractToolTarget('web_fetch', '{"url":"https://x')).toBe('')
  })
})
