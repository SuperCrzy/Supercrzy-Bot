import { createHash } from 'node:crypto'
import { resolve } from 'node:path'


/** The path a write targeted, or '' when the arguments do not say. */
function writtenPath(call: { name: string; arguments: string }): string {
  try {
    const args = JSON.parse(call.arguments) as { path?: unknown; file_path?: unknown }
    const raw = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : ''
    return raw.trim()
  } catch { return '' }
}

/** Did a later file_read in this turn look at the same path? */
function readBackAfterWrite(write: { name: string; arguments: string }, calls: Array<[string, { name: string; arguments: string }]>): boolean {
  const target = writtenPath(write)
  if (!target) return false
  let seenWrite = false
  for (const [, call] of calls) {
    if (call === write) { seenWrite = true; continue }
    if (!seenWrite || call.name !== 'file_read') continue
    let readPath = ''
    try {
      const args = JSON.parse(call.arguments) as { path?: unknown }
      if (typeof args.path === 'string') readPath = args.path.trim()
    } catch { continue }
    // Compare resolved paths so "./a.txt" and an absolute path count as the same file.
    if (readPath && (readPath === target || resolve(readPath) === resolve(target))) return true
  }
  return false
}

/** Parse only a final, explicitly structured report. Missing or ambiguous means stop. */
export function parseGoalTurnReport(answer: string, calls: Map<string, { name: string; arguments: string }>, results: Map<string, { content: string; denied: boolean }>, hadInteraction: boolean): { summary: string; fingerprint?: string } {
  const match = /\s*<goal_report>\s*([\s\S]*?)\s*<\/goal_report>\s*$/.exec(answer)
  if (!match) return { summary: answer }
  const summary = answer.slice(0, match.index).trim()
  if (hadInteraction) return { summary }
  // Whether a second autonomous turn may start.
  //
  // This used to be "any non-read-only call stops the goal", which meant a goal that
  // wrote a file ran exactly one turn and stopped — not a long-running goal at all.
  // The worry behind it is real: without idempotency, re-running a write can duplicate
  // its effect. The answer is not to refuse to continue, but to require proof that the
  // effect landed.
  //
  // A write is accepted when the same turn later read it back (a file_read of the same
  // path), and that read is part of the evidence. That covers the common multi-step
  // goal — create three files — while still refusing to continue past a write nobody
  // verified. Anything whose effect cannot be checked from inside the turn (network,
  // shell, device control) still stops the goal.
  const readOnlyTools = new Set(['file_read', 'skill_list', 'skill_view', 'memory_list'])
  const verifiableWrites = new Set(['file_write', 'multi_edit'])
  const callList = [...calls.entries()]
  const unverified = callList.some(([, call]) => !readOnlyTools.has(call.name) && !verifiableWrites.has(call.name))
  if (unverified) return { summary }
  // Every write must have been read back in this turn, before the report is honoured.
  for (const [, call] of callList) {
    if (!verifiableWrites.has(call.name)) continue
    if (!readBackAfterWrite(call, callList)) return { summary }
  }
  let report: any
  try { report = JSON.parse(match[1]) } catch { return { summary } }
  if (report?.action !== 'continue' || !Array.isArray(report.evidence_call_ids) || report.evidence_call_ids.length === 0 || report.evidence_call_ids.length > 10) return { summary }
  const evidence: string[] = []
  for (const id of report.evidence_call_ids) {
    if (typeof id !== 'string') return { summary }
    const call = calls.get(id), result = results.get(id)
    // Tool executors return some failures as text rather than structured status.
    // Do not treat those known dispatcher and guardrail failures as progress.
    if (!call || !result || result.denied || !result.content.trim() || /^\s*(?:❌|⛔|error\b|tool execution error\b|failed to parse tool arguments\b|unknown tool\b|skill not found\b|错误|失败)/i.test(result.content)) return { summary }
    evidence.push(JSON.stringify([call.name, call.arguments, result.content]))
  }
  return { summary, fingerprint: createHash('sha256').update(evidence.sort().join('\n')).digest('hex') }
}
