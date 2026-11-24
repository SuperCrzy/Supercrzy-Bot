import type Database from 'better-sqlite3'
import type { Context } from 'koa'
import { GoalCoordinator, type GoalRunner } from './goal-coordinator'
import { makeGoalAgentRunner } from './goal-agent-adapter'

type RuntimeDependencies = {
  handler: (ctx: Context) => Promise<void>
  requestStop: (sessionId: string) => unknown
  currentAccount: () => string | null
}

function plainText(content: string): string {
  if (!content.trimStart().startsWith('[')) return content
  try {
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed)) return parsed.filter(item => item?.type === 'text').map(item => String(item.text || '')).join('\n')
  } catch { /* use original text */ }
  return content
}

/** Compose the regular Agent handler with a per-run account and persisted history. */
export function createGoalRuntime(db: Database.Database, deps: RuntimeDependencies): GoalCoordinator {
  const runner: GoalRunner = async input => {
    const owner = deps.currentAccount()
    if (!owner) return { outcome: 'interrupted', summary: '账号不可用，执行未开始。' }
    const adapter = makeGoalAgentRunner({
      handler: deps.handler,
      requestStop: deps.requestStop,
      ownerIsCurrent: () => deps.currentAccount() === owner,
      makeMessages: async (sessionId, objective, acceptance) => {
        const rows = db.prepare("SELECT role, content FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY created_at DESC, rowid DESC LIMIT 40")
          .all(sessionId) as Array<{ role: string; content: string }>
        const history = rows.reverse().map(row => ({ role: row.role, content: plainText(row.content).slice(0, 20_000) }))
        // A goal can span several runs and automatic turns. last_result alone
        // loses older progress; include a bounded, persisted recent history.
        const progressRows = db.prepare(`SELECT stamp, summary FROM (
          SELECT created_at AS stamp, json_extract(payload, '$.summary') AS summary
            FROM persistent_goal_events WHERE goal_id = ? AND event = 'goal_turn' AND json_valid(payload)
          UNION ALL
          SELECT ended_at AS stamp, result AS summary FROM persistent_goal_runs
            WHERE goal_id = ? AND ended_at IS NOT NULL AND result IS NOT NULL
        ) WHERE summary IS NOT NULL AND summary != '' ORDER BY stamp DESC LIMIT 8`)
          .all(input.goal.id, input.goal.id) as Array<{ stamp: number; summary: string }>
        const progress = progressRows.reverse().map(row => String(row.summary).slice(0, 2000)).join('\n---\n')
        const priorProgress = progress ? `\n近期执行记录（可能基于修改前的目标，也可能包含未完成或中断的工作，请核实）：\n${progress}` : ''
        const previous = input.goal.last_result ? `\n上轮结果（先核实，勿盲目重做）：\n${input.goal.last_result}` : ''
        history.push({ role: 'user', content: `[持续目标]\n${objective}${acceptance ? `\n验收条件：\n${acceptance}` : ''}${priorProgress}${previous}\n请推进目标；遇到必要确认或缺失信息时停下。不要把本轮结束当成目标完成，重复有副作用的操作前先核实。若目标仍未完成且本轮取得可核实进展，在回复末尾输出 <goal_report>{"action":"continue","evidence_call_ids":["本轮成功工具调用的完整 ID"]}</goal_report>；没有进展、需要用户或需要人工验收时不要输出此报告。` })
        return history
      },
    })
    return adapter(input)
  }
  return new GoalCoordinator(db, runner)
}
