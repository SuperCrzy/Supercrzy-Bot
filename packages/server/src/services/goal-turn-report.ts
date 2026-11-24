import { createHash } from 'node:crypto'

/** Parse only a final, explicitly structured report. Missing or ambiguous means stop. */
export function parseGoalTurnReport(answer: string, calls: Map<string, { name: string; arguments: string }>, results: Map<string, { content: string; denied: boolean }>, hadInteraction: boolean): { summary: string; fingerprint?: string } {
  const match = /\s*<goal_report>\s*([\s\S]*?)\s*<\/goal_report>\s*$/.exec(answer)
  if (!match) return { summary: answer }
  const summary = answer.slice(0, match.index).trim()
  if (hadInteraction) return { summary }
  // Until tool execution has a durable idempotency mechanism, do not start a
  // second autonomous turn after an operation that could have side effects.
  // Check every call, not only the evidence selected by the model.
  const readOnlyTools = new Set(['file_read'])
  if ([...calls.values()].some(call => !readOnlyTools.has(call.name))) return { summary }
  let report: any
  try { report = JSON.parse(match[1]) } catch { return { summary } }
  if (report?.action !== 'continue' || !Array.isArray(report.evidence_call_ids) || report.evidence_call_ids.length === 0 || report.evidence_call_ids.length > 10) return { summary }
  const evidence: string[] = []
  for (const id of report.evidence_call_ids) {
    if (typeof id !== 'string') return { summary }
    const call = calls.get(id), result = results.get(id)
    if (!call || !result || result.denied || !result.content.trim() || /^\s*(?:❌|error\b|错误|失败)/i.test(result.content)) return { summary }
    evidence.push(JSON.stringify([call.name, call.arguments, result.content]))
  }
  return { summary, fingerprint: createHash('sha256').update(evidence.sort().join('\n')).digest('hex') }
}
