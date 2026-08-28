/**
 * get_goal — 长任务目标自查（对齐 Harness dsh-goal：目标不注入上下文，按需取，防漂移）
 * 示范工具：定义 + 执行器一体（ToolDef 标准接口，注册表自动收集）
 */
import type { ToolDef } from './types'
import { getDB } from '../services/database'

const getGoalTool: ToolDef = {
  name: 'get_goal',
  description: '查询当前会话的目标/计划状态（目标 + 各步骤状态与进度）。长任务执行中途调用，自查是否偏离用户原始需求。',
  category: 'system',
  parameters: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: '会话 id（一般可省略，自动用当前会话）' },
    },
  },
  execute(args: any, ctx?: any) {
    const db = getDB()
    const sessionId = args.session_id || ctx?.sessionId || null
    const plans = db
      .prepare("SELECT * FROM tasks WHERE session_id = ? AND (parent_id IS NULL OR parent_id = '') ORDER BY sort_order, created_at")
      .all(sessionId) as any[]
    if (plans.length === 0) {
      return '当前会话暂无进行中的计划/目标。若任务较复杂，可先用 create_plan 创建结构化计划（标题 + 步骤）。'
    }
    const lines: string[] = []
    for (const p of plans.slice(0, 5)) {
      const steps = db
        .prepare('SELECT subject, status, progress FROM tasks WHERE parent_id = ? ORDER BY sort_order, created_at')
        .all(p.id) as any[]
      const done = steps.filter((s) => s.status === 'completed').length
      const total = steps.length || 1
      lines.push(`## 目标：${p.subject}`)
      lines.push(`- 状态：${p.status}（${done}/${total} 步骤完成${steps.length ? '' : '，无步骤'}）`)
      if (p.description) lines.push(`- 描述：${p.description.slice(0, 200)}`)
      for (const s of steps) {
        const mark = s.status === 'completed' ? '✅' : s.status === 'in_progress' ? '⏳' : '⬜'
        lines.push(`  ${mark} [${s.status}] ${s.subject}${s.progress > 0 ? `（${s.progress}%）` : ''}`)
      }
    }
    lines.push('', '保持聚焦：回答必须服务于上述目标，若偏离请回到目标主线。')
    return lines.join('\n')
  },
}

export default getGoalTool
