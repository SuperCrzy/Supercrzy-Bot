/**
 * bg_task — background task control (P0).
 *
 * Starting a task is NOT this tool: `shell_exec({ run_in_background: true })` does that, so the
 * start path keeps the exact same approval / danger-blacklist gates as a foreground command (one
 * place to classify, not two). This tool only lists, reads and cancels.
 */
import type { ToolDef } from './types'
import { listBgTasks, readBgTaskOutput, cancelBgTask } from '../services/bg-task'

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

const tool: ToolDef = {
  name: 'bg_task',
  description:
    '管理后台任务：list 列出（状态/已运行时长/最后输出多久前）/ output 读增量输出 / cancel 取消。'
    + '启动后台任务请用 shell_exec 的 run_in_background 参数。'
    + '长任务别空等：跑一会儿后用 output 看一眼增量，或看 list 里的“最后输出 Ns 前”判断是不是卡住了。',
  category: 'system',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'output', 'cancel'], description: '要执行的动作' },
      id: { type: 'string', description: 'action=output/cancel 时的任务 id（8 位）' },
      from: { type: 'number', description: 'action=output 时的读取起点（上次返回的 next），默认 0' },
    },
    required: ['action'],
  },
  async execute(args, ctx) {
    const action = String(args.action || '').trim()
    const sessionId = ctx?.sessionId || ''

    if (action === 'list') {
      const list = listBgTasks(sessionId)
      if (!list.length) return '当前没有后台任务。'
      const lines = list.map((t) => {
        const dur = fmtElapsed((t.endedAt ?? Date.now()) - t.startedAt)
        const state = t.status === 'running' ? `运行中 ${dur}` : `${t.status} ${dur}`
        const code = t.exitCode === null ? '' : ` exit=${t.exitCode}`
        // 最后输出距今多久：判断"还在推进"还是"卡住"的唯一可靠信号（没有进度百分比这回事）
        const idle = fmtElapsed(Date.now() - (t.lastOutputAt || t.startedAt))
        return `- ${t.id}  [${state}${code}  最后输出 ${idle} 前]  ${t.title}`
      })
      return [`后台任务 ${list.length} 个：`, ...lines].join('\n')
    }

    if (action === 'output') {
      const id = String(args.id || '').trim()
      if (!id) return '缺少 id。'
      const r = readBgTaskOutput(id, Number(args.from || 0))
      if (!r.ok) return r.error
      const head = r.truncated ? '[更早的输出已被丢弃]\n' : ''
      const note = `\n[next=${r.next}]`
      return `${head}${r.text || '(暂无输出)'}${note}`
    }

    if (action === 'cancel') {
      const id = String(args.id || '').trim()
      if (!id) return '缺少 id。'
      const r = cancelBgTask(id)
      return r.ok ? `已取消 ${id}` : r.error || '取消失败'
    }

    return `未知 action: ${action}（可选 list / output / cancel）`
  },
}

export default tool
