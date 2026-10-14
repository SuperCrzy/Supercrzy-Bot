/**
 * 验证两条修复方向：
 *  A. sanitizeToolCallSequence 降级时保留 reasoning_content（不改语义，只是别把字段丢掉）
 *  B. 兜底不变量：尾部"纯文本 assistant"缺 rc 字段时补空串 ""
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

const SYS = { role: 'system', content: '你是助手。' }
const U = { role: 'user', content: '读 a.ts 再总结' }
const CALL = { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }
const A_TC_RC = { role: 'assistant', content: '', reasoning_content: '我需要读文件。', tool_calls: [CALL] }
const T = { role: 'tool', tool_call_id: 'call_1', content: '（内容）' }
// sanitizeToolCallSequence 现在产出的降级消息（丢掉了 rc）
const DEMOTED_NOW = { role: 'assistant', content: '（该轮工具调用记录不完整，已省略）' }
// 修复 A 后应产出的降级消息（保留 rc）
const DEMOTED_FIXA = { role: 'assistant', content: '（该轮工具调用记录不完整，已省略）', reasoning_content: '我需要读文件。' }
// 修复 B：给缺 rc 的纯文本 assistant 补空串
const DEMOTED_FIXB = { role: 'assistant', content: '（该轮工具调用记录不完整，已省略）', reasoning_content: '' }
// 纯文本、模型自己就没产出思考（rc 字段缺失）
const A_TEXT_NO_RC = { role: 'assistant', content: '总结完成。' }
const A_TEXT_FIXB = { role: 'assistant', content: '总结完成。', reasoning_content: '' }

async function probe(name: string, msgs: any[], key: string) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL, messages: msgs, max_tokens: 24, stream: false,
      temperature: 0.3, tools: TOOLS, tool_choice: 'auto',
    }),
  })
  let v: string
  if (res.ok) { try { await res.json() } catch { /* ignore */ }; v = '200 OK' }
  else {
    const t = await res.text()
    let m = t
    try { m = JSON.parse(t)?.error?.message || t } catch { /* ignore */ }
    m = String(m)
    v = m.includes('reasoning_content') ? '400 RC ← 仍然触发' : `400 ${m.slice(0, 50)}`
  }
  console.log(`  ${v.padEnd(18)} ${name}`)
}

async function main() {
  const key = apiKey()
  console.log(`模型 ${MODEL}\n`)
  console.log('--- 现状（sanitize 降级丢 rc）→ 这就是生产里 400 的样子 ---')
  await probe('降级后丢 rc（当前行为）  ', [SYS, U, A_TC_RC, T, DEMOTED_NOW], key)

  console.log('\n--- 修复 A：降级时保留 rc ---')
  await probe('降级但保留 rc            ', [SYS, U, A_TC_RC, T, DEMOTED_FIXA], key)

  console.log('\n--- 修复 B：缺 rc 时补空串 ---')
  await probe('降级 + 补空串            ', [SYS, U, A_TC_RC, T, DEMOTED_FIXB], key)
  await probe('模型本就没 rc 的纯文本   ', [SYS, U, A_TC_RC, T, A_TEXT_NO_RC], key)
  await probe('同上但补空串             ', [SYS, U, A_TC_RC, T, A_TEXT_FIXB], key)

  console.log('\n--- 再确认一次原规则（带 tool_calls 的缺 rc 不触发）---')
  await probe('尾部 tc 型 assistant 缺 rc', [SYS, U, A_TC_RC, T, { role: 'assistant', content: '', tool_calls: [{ ...CALL, id: 'call_2' }] }, { role: 'tool', tool_call_id: 'call_2', content: 'x' }], key)
}

main().catch((e) => { console.error(e); process.exit(1) })
