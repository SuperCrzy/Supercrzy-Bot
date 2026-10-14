/**
 * 决定性回放：把当时失败/取消的检查点消息，按 agent.ts 完全相同的构造方式发真实请求。
 * 目标：能否复现 400 "reasoning_content must be passed back"。
 */
import fs from 'node:fs'
import path from 'node:path'
import { sanitizeToolCallSequence } from '../../packages/server/src/services/agent'
import type { AgentMessage } from '../../packages/server/src/services/agent'

const DIR = path.resolve('packages/server/data/checkpoints')
const HOME = process.env.HOME || ''
const DB = path.join(HOME, '.supercrzy/data/supercrzy.db')

function apiKey(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3')
  const db = new Database(DB, { readonly: true })
  const r = db.prepare("select api_key from custom_providers where id='preset-deepseek'").get() as any
  return r?.api_key || (db.prepare("select value from settings where key='apiKey'").get() as any)?.value
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'read_file',
    description: '读取一个文件的完整内容',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
}]

async function send(messages: any[], key: string, opts: { stream: boolean; effort?: string; tools?: boolean }) {
  const body: any = {
    model: 'deepseek-v4-flash',
    messages,
    temperature: 0.3,
    max_tokens: 64,
    stream: opts.stream,
  }
  if (opts.tools !== false) { body.tools = TOOLS; body.tool_choice = 'auto' }
  if (opts.effort) body.reasoning_effort = opts.effort
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  })
  if (res.ok) {
    if (opts.stream) { try { await res.text() } catch { /* ignore */ } }
    else { try { await res.json() } catch { /* ignore */ } }
    return { code: 200, msg: '' }
  }
  const t = await res.text()
  let m = t
  try { m = JSON.parse(t)?.error?.message || t } catch { /* raw */ }
  return { code: res.status, msg: String(m).slice(0, 200) }
}

const CASES = [
  '1e9879b6-ff32-4c13-98af-7c1260aaf384.json',
  '034090c5-5da4-4180-a58b-0210193b60a0.json',
  'fba204ce-5802-490f-aa6d-fcc67c3319cc.json',
  '71b99e13-3a70-45e1-a530-3e267b11f38b.json',
  '27060ba8-d5ac-4042-842e-fb6ae4a45b17.json',
  '2d52c7de-48e0-44d7-b855-98eb1a0357a6.json',
]

async function main() {
  const key = apiKey()
  for (const f of CASES) {
    const p = path.join(DIR, f)
    if (!fs.existsSync(p)) { console.log(`  ${f} 不存在`); continue }
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const raw = (j.messages || []) as AgentMessage[]
    const clean = sanitizeToolCallSequence(raw)
    console.log(`\n--- ${f}  (消息 ${raw.length} → 清洗后 ${clean.length}) ---`)
    for (const [tag, msgs] of [['清洗后', clean], ['未清洗', raw]] as const) {
      for (const stream of [false, true]) {
        for (const effort of ['low', 'medium', undefined]) {
          const apiMsgs = [{ role: 'system', content: '你是助手。' }, ...msgs]
          const r = await send(apiMsgs, key, { stream, effort })
          const label = `${tag} stream=${String(stream).padEnd(5)} effort=${String(effort).padEnd(6)}`
          if (r.code === 200) console.log(`    [200] ${label}`)
          else console.log(`    [${r.code}] ${label}  → ${r.msg}`)
        }
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
