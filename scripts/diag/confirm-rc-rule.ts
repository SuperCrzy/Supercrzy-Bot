/**
 * 边界确认：把"末条 assistant 缺 rc"这条规则的精确判据钉死，用于设计修复。
 */
import path from 'node:path'

const DB = path.join(process.env.HOME || '', '.supercrzy/data/supercrzy.db')
const MODEL = process.argv[2] || 'deepseek-v4-flash'

function apiKey(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3')
  const db = new Database(DB, { readonly: true })
  const row: any = db.prepare("select api_key from custom_providers where id='preset-deepseek'").get()
  if (!row?.api_key) throw new Error('未取到 api key')
  return row.api_key
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'read_file', description: '读取文件',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
}]

const CALL = { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }
const SYS = { role: 'system', content: '你是助手。' }
const U = { role: 'user', content: '读 a.ts' }
const A_NO = { role: 'assistant', content: '文件内容…' }
const A_RC = { role: 'assistant', content: '文件内容…', reasoning_content: '我需要读文件。' }
const A_RC_EMPTY = { role: 'assistant', content: '文件内容…', reasoning_content: '' }
const A_RC_WS = { role: 'assistant', content: '文件内容…', reasoning_content: '   ' }
const A_TC = { role: 'assistant', content: '', reasoning_content: '读文件。', tool_calls: [CALL] }
const T = { role: 'tool', tool_call_id: 'call_1', content: '（内容）' }
const S = { role: 'system', content: '请继续。' }

async function probe(name: string, msgs: any[], key: string, withTools = true) {
  const body: any = { model: MODEL, messages: msgs, max_tokens: 24, stream: false, temperature: 0.3 }
  if (withTools) { body.tools = TOOLS; body.tool_choice = 'auto' }
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  })
  let v: string
  if (res.ok) { try { await res.json() } catch { /* ignore */ }; v = '200 OK' }
  else {
    const t = await res.text()
    let m = t
    try { m = JSON.parse(t)?.error?.message || t } catch { /* ignore */ }
    m = String(m)
    v = m.includes('reasoning_content') ? '400 RC'
      : /must be a response to a preceding|must be followed by tool/.test(m) ? '400 ORPHAN'
      : `400 ${m.slice(0, 40)}`
  }
  console.log(`  ${v.padEnd(11)} ${name}`)
  return v
}

const CASES: Array<[string, any[], boolean]> = [
  ['末条=assistant 无 rc           ', [SYS, U, A_NO], true],
  ['末条=assistant rc 空串 ""      ', [SYS, U, A_RC_EMPTY], true],
  ['末条=assistant rc 全空白 "   " ', [SYS, U, A_RC_WS], true],
  ['末条=assistant 有 rc           ', [SYS, U, A_RC], true],
  ['末条=assistant(tc+rc) 无 T     ', [SYS, U, A_TC], true],
  ['末条=assistant 有 rc 后跟 T    ', [SYS, U, A_RC, T], true],
  ['末条=system（前面是无rc asst） ', [SYS, U, A_NO, S], true],
  ['末条=user（前面是无rc asst）   ', [SYS, U, A_NO, { role: 'user', content: 'x' }], true],
  ['末条=assistant 无rc 无 tools   ', [SYS, U, A_NO], false],
  ['[无rc, 有rc] 末条有rc          ', [SYS, U, A_NO, A_RC], true],
  ['[有rc, 无rc] 末条无rc          ', [SYS, U, A_RC, A_NO], true],
  ['末条=tool（前有 tc+rc）        ', [SYS, U, A_TC, T], true],
]

async function main() {
  const key = apiKey()
  console.log(`模型 ${MODEL}\n`)
  for (const [n, m, wt] of CASES) await probe(n, m, key, wt)
}

main().catch((e) => { console.error(e); process.exit(1) })
