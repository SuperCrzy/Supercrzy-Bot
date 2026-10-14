/**
 * 验收测试：真实失败检查点 → 走修复后的发请求管线 → 是否还 400。
 *
 * 对比三组：
 *   ① 原样（修复前实际发出去的东西）
 *   ② 只跑旧管线 sanitizeToolCallSequence
 *   ③ 新管线 sanitizeToolCallSequence + ensureReasoningEcho
 */
import fs from 'node:fs'
import path from 'node:path'
import { sanitizeToolCallSequence, ensureReasoningEcho } from '../../packages/server/src/services/agent'
import type { AgentMessage } from '../../packages/server/src/services/agent'

const DIR = path.resolve('packages/server/data/checkpoints')
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

async function replay(msgs: any[], key: string) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL, messages: [{ role: 'system', content: '你是助手。' }, ...msgs],
      max_tokens: 24, stream: false, temperature: 0.3, tools: TOOLS, tool_choice: 'auto',
    }),
  })
  if (res.ok) { try { await res.json() } catch { /* ignore */ } ; return '200 OK' }
  const t = await res.text()
  let m = t
  try { m = JSON.parse(t)?.error?.message || t } catch { /* ignore */ }
  m = String(m)
  if (m.includes('reasoning_content')) return '400 RC'
  if (/must be a response to a preceding|must be followed by tool/.test(m)) return '400 ORPHAN'
  if (/too busy/i.test(m)) return 'RATE_LIMIT(忽略)'
  return `400 ${m.slice(0, 40)}`
}

// 当时失败/取消 + 之前抽到会 400 的样本
const CASES = [
  ['1e9879b6', '当时失败（浏览器+写脚本，30.6s 卡死）'],
  ['034090c5', '当时失败（读 fold-state.ts，98.7s）'],
  ['2d52c7de', '当时同批失败'],
  ['fba204ce', '当时取消（tool_sequence）'],
  ['71b99e13', '当时取消'],
  ['27060ba8', '当时成功（回归对照）'],
]

async function main() {
  const key = apiKey()
  const files = fs.readdirSync(DIR)
  console.log(`模型 ${MODEL}\n`)
  console.log('  检查点     修复前(原样)   旧管线     新管线      说明')
  console.log('  ' + '-'.repeat(78))

  const tally = { raw: {} as Record<string, number>, old: {} as Record<string, number>, neu: {} as Record<string, number> }
  for (const [prefix, note] of CASES) {
    const f = files.find((x) => x.startsWith(prefix))
    if (!f) { console.log(`  ${prefix}  不存在`); continue }
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).messages as AgentMessage[]
    const old = sanitizeToolCallSequence(raw)
    const neu = ensureReasoningEcho(old, { withTools: true, model: MODEL, baseUrl: 'https://api.deepseek.com/v1' })

    const a = await replay(raw, key)
    await new Promise((r) => setTimeout(r, 400))
    const b = await replay(old, key)
    await new Promise((r) => setTimeout(r, 400))
    const c = await replay(neu, key)
    await new Promise((r) => setTimeout(r, 400))

    tally.raw[a] = (tally.raw[a] || 0) + 1
    tally.old[b] = (tally.old[b] || 0) + 1
    tally.neu[c] = (tally.neu[c] || 0) + 1

    const mark = (v: string) => v.padEnd(13)
    console.log(`  ${prefix}  ${mark(a)} ${mark(b)} ${mark(c)} ${note}`)
  }

  console.log('\n=== 汇总 ===')
  console.log('  修复前(原样) :', JSON.stringify(tally.raw))
  console.log('  旧管线       :', JSON.stringify(tally.old))
  console.log('  新管线       :', JSON.stringify(tally.neu))
}

main().catch((e) => { console.error(e); process.exit(1) })
