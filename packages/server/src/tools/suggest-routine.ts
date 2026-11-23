/**
 * suggest_routine — let the model decide whether a finished task is worth reusing.
 *
 * The previous trigger was mechanical: three turns plus three tool calls. That
 * fires on genuinely one-off work ("analyse this file") as readily as on a task
 * the user repeats weekly, so the prompt showed up after almost every reply and
 * stopped meaning anything. Whether something is worth repeating is a judgement
 * about the request, not a count, so it belongs to the model.
 *
 * The tool only records the intent. The agent loop reads it back when the turn
 * finishes and emits `routine_suggest` on the stream, which is what the chat view
 * renders as the suggestion card.
 */
import type { ToolDef } from './types'

/** Per-session mark set by the tool, consumed by the agent loop at turn end. */
const suggestions = new Map<string, { title: string; reason: string }>()

function keyOf(ctx: { sessionId?: string } | undefined): string {
  return ctx?.sessionId || ''
}

/** Pop and clear the pending suggestion for a session. */
export function takeRoutineSuggestion(sessionId: string | undefined): { title: string; reason: string } | undefined {
  const key = sessionId || ''
  const found = suggestions.get(key)
  if (found) suggestions.delete(key)
  return found
}

export function clearRoutineSuggestion(sessionId: string | undefined) {
  suggestions.delete(sessionId || '')
}

const tool: ToolDef = {
  name: 'suggest_routine',
  description: [
    'Call this when the task you just finished is worth saving as a reusable routine —',
    'but only when the user would genuinely run it again. Good signals: they mention a',
    'cadence (每天/每周/每月/每小时/定期), they repeat the same request with different data',
    '(查某站流量、抓某类新闻、生成某种报表), or the steps are fixed and only the inputs change.',
    'Do NOT call it for one-off work: reading a specific file, fixing this bug, explaining',
    'this error, analysing the document just attached, or anything whose value was the',
    'single answer it produced. When in doubt, do not call it — a routine suggestion that',
    'appears after every task trains the user to ignore it.',
    'At most once per turn.',
  ].join(' '),
  category: 'memory',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short name for the routine, in the user\'s language, under 20 characters (e.g. 每日网站流量查询)',
      },
      reason: {
        type: 'string',
        description: 'One sentence on why this repeats — cite the cadence or the repeated pattern you saw',
      },
    },
    required: ['title'],
  },
  async execute(args, ctx) {
    const title = String(args.title || '').trim()
    if (!title) return '❌ 缺少 title'
    const reason = String(args.reason || '').trim()
    const key = keyOf(ctx)
    // One suggestion per turn: a second call would stack cards on the same reply.
    if (suggestions.has(key)) return '已记录本轮的例程建议，无需重复调用。'
    suggestions.set(key, { title: title.slice(0, 40), reason })
    return `已记录例程建议「${title}」，任务结束时会向用户展示保存入口。`
  },
}

export default tool
