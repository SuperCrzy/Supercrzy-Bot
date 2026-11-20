/** Round 2: correct arguments for the tools that round 1 called with bad params. */
import { initDatabase } from '../../src/services/database.js'
import { directoryTools } from '../../src/tools/registry.js'
import fs from 'node:fs'

initDatabase()
const WORK = '/tmp/toolcheck2'
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })
fs.writeFileSync(`${WORK}/a.txt`, 'alpha\n')

const ctx: any = { cwd: process.cwd(), workspaceDir: process.cwd(), onOutput: () => {}, onProgress: () => {}, shouldStop: () => false }

const CASES: Array<{ name: string; args: any }> = [
  { name: 'memory_store', args: { key: 'toolcheck_probe', content: 'toolcheck probe 2026-11-20', category: 'fact', importance: 1 } },
  { name: 'memory_recall', args: { query: 'toolcheck_probe' } },
  { name: 'task_create', args: { subject: 'toolcheck task', description: 'probe' } },
  { name: 'draw_diagram', args: { title: 'probe', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 200"><rect x="10" y="10" width="120" height="60" fill="#333"/><text x="20" y="45" fill="#fff">A</text></svg>' } },
  { name: 'create_plan', args: { title: 'probe plan', steps: [{ step: 'one' }, { step: 'two' }] } },
  { name: 'make_article', args: { url: 'https://example.com' } },
  { name: 'browser', args: { action: 'status' } },
  { name: 'news_search', args: { query: 'AI' } },
  { name: 'skill_list', args: {} },
  { name: 'terminal_open', args: {} },
  { name: 'file_write', args: { path: `${WORK}/cn.txt`, content: '中文测试内容\n' } },
  { name: 'shell_exec', args: { command: 'echo 中文输出测试' } },
]

for (const c of CASES) {
  const t = directoryTools.find(x => x.name === c.name)
  if (!t) { console.log(`MISSING ${c.name}`); continue }
  const t0 = Date.now()
  let out = '', err = ''
  try { const r = await t.execute(c.args, ctx); out = typeof r === 'string' ? r : JSON.stringify(r) }
  catch (e: any) { err = e?.message || String(e) }
  const ms = Date.now() - t0
  const text = out || err
  const verdict = err ? 'ERR ' : (/^❌/.test(out) ? 'FAIL' : 'OK  ')
  console.log(`${verdict} ${c.name.padEnd(16)} ${String(ms+'ms').padEnd(7)} ${text.replace(/\s+/g,' ').slice(0,150)}`)
}
