/**
 * Real invocation of every registered tool, printing what it actually returned.
 * Not a status check: each tool is executed with minimal valid arguments.
 */
import { initDatabase } from '../../src/services/database.js'
import { directoryTools } from '../../src/tools/registry.js'
import fs from 'node:fs'

initDatabase()

const WORK = '/tmp/toolcheck'
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })
fs.writeFileSync(`${WORK}/probe.txt`, 'line one\nline two\n中文一行\n')

const ctx: any = {
  cwd: process.cwd(),
  workspaceDir: process.cwd(),
  onOutput: () => {},
  onProgress: () => {},
  shouldStop: () => false,
}

// Minimal valid arguments per tool. Anything not listed gets {} and we accept
// a validation error as "constructs correctly", which is still information.
const ARGS: Record<string, any> = {
  file_read: { path: `${WORK}/probe.txt` },
  file_write: { path: `${WORK}/out.txt`, content: 'hello\n中文\n' },
  file_exists: { path: `${WORK}/probe.txt` },
  multi_edit: { path: `${WORK}/probe.txt`, edits: [{ oldText: 'line one', newText: 'line ONE' }] },
  file_delete: { path: `${WORK}/out.txt` },
  shell_exec: { command: 'echo probe-ok' },
  web_fetch: { url: 'https://example.com' },
  web_search: { query: 'Anthropic IPO 估值' },
  news_search: { query: 'AI' },
  memory_store: { content: 'toolcheck probe 2026-11-20', category: 'fact', importance: 1 },
  memory_recall: { query: 'toolcheck' },
  memory_list: {},
  task_create: { title: 'toolcheck task' },
  task_list: {},
  draw_diagram: { prompt: 'flowchart: A -> B', type: 'flowchart' },
  tool_search: { query: 'file' },
  lint_file: { path: `${WORK}/probe.txt` },
  git_status: {},
  git_diff: {},
  create_plan: { goal: 'probe' },
  read_me: {},
  skill_list: {},
  apply_patch: {},
}

const only = process.argv[2]
const rows: string[] = []
for (const t of directoryTools) {
  if (only && t.name !== only) continue
  const args = ARGS[t.name] ?? {}
  const t0 = Date.now()
  let out = ''
  let err = ''
  try {
    const r = await t.execute(args, ctx)
    out = typeof r === 'string' ? r : JSON.stringify(r)
  } catch (e: any) {
    err = e?.message || String(e)
  }
  const ms = Date.now() - t0
  const head = (out || err).replace(/\s+/g, ' ').slice(0, 96)
  const bad = !!err || /^❌|权限|未授权|not permitted/i.test(out)
  rows.push(`${bad ? 'FAIL' : 'OK  '} ${t.name.padEnd(22)} ${String(ms + 'ms').padEnd(8)} ${head}`)
}
console.log(rows.join('\n'))
