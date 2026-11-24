/**
 * propose_goal — the agent opens a persistent goal for a large, explicit project.
 *
 * The goal appears above the input box in the paused state; the user reviews,
 * edits or ignores it, and only the user's Start click begins execution. The
 * agent never starts it: a proposal that runs itself is a surprise, not a plan.
 *
 * This is deliberately a deferred tool. Proposing a goal is rare, and the
 * description below is the only instruction the model reads at call time, so the
 * bar is written into it rather than left to the prompt alone.
 */
import type { ToolDef } from './types'
import { getDB } from '../services/database'
import { createPersistentGoal, getOpenPersistentGoal } from '../services/persistent-goals'

const proposeGoalTool: ToolDef = {
  name: 'propose_goal',
  description: `为「大项目」在当前会话上方提出一个持续目标（用户确认后才执行）。只在同时满足三条时调用：
1. 用户描述的是一个跨多轮/多会话的大项目（端到端搭建、迁移、系统性改造、长期研究），不是一次性问题、单文件修改或小 bug；
2. 用户对「做成什么样」有明确表述，能据此写出可验证的验收条件；
3. 当前会话还没有进行中的目标。
objective 用一句话写清最终状态（用户的语言），acceptance 写可量化的验收标准。
禁止用于常规任务、头脑风暴或单纯的提问；也禁止由你启动或恢复目标——用户自己点「开始推进」。拿不准就不要提。`,
  category: 'system',
  parameters: {
    type: 'object',
    properties: {
      objective: { type: 'string', description: '一句话写清项目最终要达到的状态（≤20000 字符，用户的语言）' },
      acceptance: { type: 'string', description: '可验证的验收条件，逐条列出（选填，≤20000 字符）' },
    },
    required: ['objective'],
  },
  execute(args: any, ctx?: any) {
    const db = getDB()
    const sessionId = String(ctx?.sessionId || '')
    if (!sessionId) return '无法提出目标：当前没有会话上下文。'
    const objective = typeof args?.objective === 'string' ? args.objective.trim() : ''
    if (!objective) return '无法提出目标：objective 不能为空。'
    const acceptance = typeof args?.acceptance === 'string' ? args.acceptance.trim() : ''
    const open = getOpenPersistentGoal(db, sessionId)
    if (open) {
      return `当前会话已有目标（${open.status}）：${open.objective.slice(0, 200)}。未重复创建——如需调整，请让用户编辑或先结束该目标。`
    }
    try {
      const goal = createPersistentGoal(db, sessionId, objective, acceptance, 'ai')
      const lines = [
        '已把目标放在输入框上方，等待用户确认（当前状态：已暂停，未执行）。',
        `- 目标：${goal.objective}`,
      ]
      if (goal.acceptance) lines.push(`- 验收条件：${goal.acceptance}`)
      lines.push('用户点「开始推进」才会执行；不要自行启动或恢复目标。用一句话告诉用户目标已提出、在哪里确认即可。')
      return lines.join('\n')
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      if (code === 'goal_already_exists') return '当前会话已有目标，未重复创建。'
      if (code === 'invalid_goal') return '无法提出目标：objective 或 acceptance 超过 20000 字符。'
      if (code === 'session_not_found') return '无法提出目标：会话不存在。'
      throw error
    }
  },
}

export default proposeGoalTool
