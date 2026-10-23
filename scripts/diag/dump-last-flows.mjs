/**
 * Dump the `flow` segmentation of the most recent assistant messages.
 *
 * Why: "为什么这条回复只有 3 段文字？" can only be answered from real data — the renderer shows a
 * text segment per narration run between tool calls, so the count is decided by the model + the
 * segment-closing rule, not by the UI. This prints text nodes, tool nodes and the final content
 * length side by side so the two can be compared.
 *
 * Usage:
 *   node scripts/diag/dump-last-flows.mjs [limit]
 */
import Database from 'better-sqlite3'
import { homedir } from 'os'

const limit = Number(process.argv[2] || 3)
const db = new Database(`${homedir()}/.supercrzy/data/supercrzy.db`, { readonly: true })
const rows = db
  .prepare(
    `SELECT id, created_at, content, attachments FROM messages
     WHERE role='assistant' AND attachments LIKE '%"flow"%'
     ORDER BY created_at DESC LIMIT ?`,
  )
  .all(limit)

for (const r of rows) {
  // flow 存在 attachments JSON 的 .flow 里（messages 表没有独立列）
  let flow
  try {
    flow = JSON.parse(r.attachments || '{}').flow
  } catch {
    flow = null
  }
  if (!Array.isArray(flow)) {
    console.log(`\n=== msg ${String(r.id).slice(0, 8)} — attachments 里没有合法 flow`)
    continue
  }
  const isText = (n) => n?.kind === 'text' || n?.type === 'text'
  const isTool = (n) => n?.kind === 'tool_call' || n?.type === 'tool_call'
  const texts = flow.filter(isText)
  const tools = flow.filter(isTool)

  console.log(`\n=== msg ${String(r.id).slice(0, 8)} @ ${r.created_at}`)
  console.log(`    nodes=${flow.length}  text=${texts.length}  tool=${tools.length}  content=${(r.content || '').length} 字`)
  texts.forEach((t, i) => {
    const s = String(t.text ?? t.node?.text ?? '').replace(/\n/g, ' ')
    console.log(`  T${i + 1} ${s.length}字 「${s.slice(0, 70)}${s.length > 70 ? '…' : ''}」`)
  })
  tools.forEach((t, i) => {
    const n = t.node || t
    console.log(`  ⚙${i + 1} ${n.name || n.toolName || '?'} status=${n.status || '?'}`)
  })
}
