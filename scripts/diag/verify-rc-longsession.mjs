/**
 * #0 验收：**真实长会话**恢复 → 跑 ≥2 轮工具 → 看 reasoning_content 400 是否复现。
 *
 * 与 e2e-multitool-stability.mjs 的区别（两个都要，因为问的是两件事）：
 *   · stability 脚本：**新**会话（stab-*），证明"干净会话跑多工具稳"
 *   · 本脚本：**真实**长会话 3fc4d08f（09-18~09-19 唯一出现过 tool_sequence 的会话），
 *     直接吃它自己失败时落盘的**真实检查点**（含 tool_calls / rc 的真实形状）
 *     ⇒ 证明"会话年龄"这个疑点是不是真凶
 *
 * 关键：那个真实检查点的尾巴正好是 400 形状 —— 末条 assistant 有 content、无 reasoning_content，
 * 且在最后一条 user 之后（降级分支产物）。所以本脚本先做**负控**证明这个形状真的会 400
 * （"指标自己有牙"），再跑端到端。
 *
 * 用法：
 *   node scripts/diag/verify-rc-longsession.mjs          # 全流程（负控 + 正控 + 端到端）
 *   node scripts/diag/verify-rc-longsession.mjs --cleanup # 删掉本次写入的 task_runs 行
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const CKPT_DIR = path.join(ROOT, 'packages/server/data/checkpoints')
const DB_PATH = path.join(process.env.HOME || '', '.supercrzy/data/supercrzy.db')
const BASE = process.env.SC_BASE || 'http://127.0.0.1:3000'

/** 唯一出现过 tool_sequence 的真实会话（09-18~09-19） */
const SESSION_ID = '3fc4d08f-e1b9-4cc9-8f04-5a8d4b4f30fd'

/** 本会话 4 次非完成记录对应的真实检查点（task_runs.checkpoint_id） */
const CKPTS = [
  ['034090c5', '09-18 09:55 failed tool_sequence（读 fold-state 测试）'],
  ['fba204ce', '09-18 10:07 cancelled tool_sequence（fold-state hasEnd）'],
  ['71b99e13', '09-18 10:11 cancelled（无 failure_code）'],
  ['1e9879b6', '09-19 14:18 failed tool_sequence（browser + file_write + shell_exec）'],
]

/** 末条 assistant 之后若无 user 消息，它就是"尾部" —— 用来判定 400 形状 */
function tailAssistantMissingRc(msgs) {
  let lastUser = -1
  msgs.forEach((m, i) => { if (m.role === 'user') lastUser = i })
  const bad = []
  for (let i = lastUser + 1; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== 'assistant') continue
    if (!Object.prototype.hasOwnProperty.call(m, 'reasoning_content')) bad.push(i)
  }
  return { lastUser, bad }
}

function readCp(prefix) {
  const f = fs.readdirSync(CKPT_DIR).find((x) => x.startsWith(prefix))
  if (!f) return null
  return { file: f, ...JSON.parse(fs.readFileSync(path.join(CKPT_DIR, f), 'utf8')) }
}

function apiKey() {
  const db = new Database(DB_PATH, { readonly: true })
  const row = db.prepare("select api_key from custom_providers where id='preset-deepseek'").get()
  db.close()
  if (!row?.api_key) throw new Error('未取到 api key')
  return row.api_key
}

/** 直接打上游，只判 HTTP 码与 400 类别。max_tokens 极小，成本可忽略。 */
async function probe(label, msgs, key, model) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, messages: [{ role: 'system', content: '你是助手。' }, ...msgs],
      max_tokens: 24, stream: false, temperature: 0.3,
      tools: [{
        type: 'function',
        function: { name: 'read_file', description: '读文件',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      }],
      tool_choice: 'auto',
    }),
  })
  let verdict
  if (res.ok) { verdict = '200 OK' } else {
    const t = await res.text()
    let m = t
    try { m = JSON.parse(t)?.error?.message || t } catch { /* ignore */ }
    m = String(m)
    verdict = m.includes('reasoning_content') ? '400 RC'
      : /must be a response to a preceding|must be followed by tool/.test(m) ? '400 ORPHAN'
      : /too busy/i.test(m) ? 'RATE_LIMIT'
      : `400 ${m.slice(0, 50)}`
  }
  console.log(`  ${verdict.padEnd(14)} ${label}`)
  return verdict
}

function parseSse(text) {
  const ev = { tool_call: 0, tool_result: 0, error: 0, content: 0, thinking: 0, done: 0 }
  const errors = []
  let contentLen = 0
  let turnMax = 0
  for (const block of text.split('\n\n')) {
    const m = /event: (\w+)\ndata: (.*)/s.exec(block)
    if (!m) continue
    const name = m[1]
    let d = {}
    try { d = JSON.parse(m[2]) } catch { /* ignore */ }
    if (name in ev) ev[name]++
    // 只认真正的错误通道。绝不扫原文：工具结果会把源码里 reasoning_content / tool_sequence 字样原样回显。
    if (name === 'error' && d.message) errors.push(String(d.message).slice(0, 220))
    if (name === 'content' && d.error && d.content) errors.push(String(d.content).slice(0, 220))
    if (name === 'content' && d.content) contentLen += String(d.content).length
    if (name === 'thinking' && typeof d.turn === 'number') turnMax = Math.max(turnMax, d.turn)
  }
  return { ev, errors, contentLen, turnMax }
}

function taskRunsSince(ts) {
  const db = new Database(DB_PATH, { readonly: true })
  const rows = db.prepare('select task_id,status,failure_code,failure_message,checkpoint_id,started_at,completed_at,duration_ms,label from task_runs where started_at >= ? order by started_at asc').all(ts)
  db.close()
  return rows
}

async function runOne(tag, body, sessionId, timeoutMs = 300000) {
  const t0 = Date.now()
  let status = 0, text = '', err = ''
  try {
    const res = await fetch(`${BASE}/api/chat/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, sessionId, agent: true, maxTurns: 12 }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    status = res.status
    text = await res.text()
  } catch (e) {
    // ⚠️ fetch 失败只打 e.message 只有 "fetch failed"，必须连 e.cause.code 一起打
    err = `${e.name}: ${e.message}${e.cause?.code ? ' / cause=' + e.cause.code : ''}`
  }
  const ms = Date.now() - t0
  const { ev, errors, contentLen, turnMax } = parseSse(text)
  const blob = errors.join(' ')
  const hit400 = /API error 400|reasoning_content|must be passed back/i.test(blob)
  const hitToolSeq = /tool_sequence/i.test(blob)
  return { tag, status, ms, ev, errors, contentLen, turnMax, hit400, hitToolSeq, err,
           rounds: ev.tool_call, stalled: ev.tool_call > 0 && ev.tool_result === 0 }
}

async function main() {
  if (process.argv.includes('--cleanup')) return cleanup()

  const key = apiKey()
  const db = new Database(DB_PATH, { readonly: true })
  const model = (db.prepare("select value from settings where key='model'").get() || {}).value || 'deepseek-v4-flash'
  db.close()

  const health = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)
  if (!health) { console.error(`服务未就绪：${BASE}/api/health 不可达`); process.exit(1) }

  console.log(`#0 长会话恢复验收 · session ${SESSION_ID.slice(0, 8)} · 模型 ${model}\n`)

  // ───────── 第 1 段：真实检查点的形状体检 + 负控（证明指标有牙）─────────
  console.log('── 第 1 段：真实失败检查点的尾部形状 + 上游负控 ──')
  const cps = {}
  for (const [prefix, note] of CKPTS) {
    const cp = readCp(prefix)
    if (!cp) { console.log(`  ${prefix}  检查点缺失，跳过`); continue }
    cps[prefix] = cp
    const { lastUser, bad } = tailAssistantMissingRc(cp.messages)
    const hasRcAnywhere = cp.messages.some((m) => Object.prototype.hasOwnProperty.call(m, 'reasoning_content'))
    const tcCount = cp.messages.filter((m) => Array.isArray(m.tool_calls) && m.tool_calls.length).length
    console.log(`\n  ${prefix}  ${cp.messages.length} 条 / turn=${cp.turn} / 带 tool_calls 的 assistant=${tcCount} / 全序列有 rc=${hasRcAnywhere}`)
    console.log(`         最后一条 user 在 #${lastUser}；其后缺 rc 字段的 assistant：${bad.length ? '#' + bad.join(',#') : '无'}`)
    console.log(`         ${note}`)
    const a = await probe(`${prefix} 原样发出（修复前形状）`, cp.messages, key, model)
    const { sanitizeToolCallSequence, ensureReasoningEcho } = await import(path.join(ROOT, 'packages/server/src/services/agent.ts'))
    const fixed = ensureReasoningEcho(sanitizeToolCallSequence(cp.messages), { withTools: true, model, baseUrl: 'https://api.deepseek.com/v1' })
    const b = await probe(`${prefix} 走当前管线（sanitize + reasoningEcho）`, fixed, key, model)
    cp._verdict = { raw: a, fixed: b, badTail: bad.length }
    await new Promise((r) => setTimeout(r, 500))
  }

  // ───────── 第 2 段：端到端 —— 把真实历史喂进**活着的** agent 循环 ─────────
  //
  // 🔴 踩过的坑（第一版整段假失败，记录在此免得再踩）：
  //   本段最初直接把"检查点原始 messages"当 body.messages 发。6 次全在 200ms 内 422：
  //     messages[25]: missing field `tool_call_id`
  //   原因是 runAgentLoop（agent.ts:1113）第一件事就是把每条消息压成 `{role, content}`
  //     messages = userMessages.map(m => ({ role: m.role, content: m.content }))
  //   —— `tool_calls` / `tool_call_id` 全部被丢掉，于是 `role:'tool'` 的历史消息变成孤儿 → 上游 422。
  //   而**真实客户端从不发这种形状**：ChatView 的 buildAPIMessage 只产出 `{role, content}` 纯文本。
  //   ⇒ 喂检查点原始数组 ≠ 模拟真实用户；要模拟真实用户必须用「客户端真实形状」。
  //
  // 真实存在的两条恢复路径（本段就测这两条）：
  //   R —— 普通聊天续跑：body.messages = 会话的 user/assistant 文本历史（= messages 表原样）+ 新提问
  //   C —— 「继续检查点」：body.resumeCheckpoint = 检查点 id，服务端自己读文件（agent.ts:1082-1107）
  console.log('\n── 第 2 段：端到端恢复（两种真实路径 → POST /api/chat/agent）──')

  // R 路径的历史：直接取 messages 表（就是客户端会发的东西）
  const sessionHistory = () => {
    const d = new Database(DB_PATH, { readonly: true })
    const rows = d.prepare('select role, content from messages where session_id = ? and role in (\'user\',\'assistant\') order by rowid asc').all(SESSION_ID)
    d.close()
    // 客户端只发最近 HISTORY_WINDOW=40 条
    return rows.slice(-40).map((r) => ({ role: r.role, content: r.content }))
  }
  const history = sessionHistory()
  const histChars = history.reduce((n, m) => n + String(m.content || '').length, 0)
  console.log(`  会话历史（客户端形状）：${history.length} 条 / ${histChars} 字符`)

  const READONLY_CONT = {
    role: 'user',
    content: '继续：先用 file_read 读 packages/client/src/utils/fold-state.ts，再用 git_status 看工作区，最后一句话说明 hasEnd 的作用。不要写文件、不要执行命令。',
  }
  // 09-19 真实失败那次的原始提问，逐字照搬（最高保真复现）
  const ORIGINAL_PROMPT = {
    role: 'user',
    content: '用浏览器打开 example.com 读出它的标题，然后写一个 Python 脚本打印斐波那契数列前 20 项，运行它并把结果贴出来',
  }

  const PRIMARY = '1e9879b6'
  const primary = cps[PRIMARY]
  if (!primary) { console.error('主检查点缺失，无法端到端'); process.exit(1) }
  // ⚠️ 续跑必须传**完整 uuid**（= 文件名去掉 .json）。第一版传了 8 位前缀 `1e9879b6`，
  //    路由会拼成 `data/checkpoints/1e9879b6.json` → ENOENT，整个 C 组假失败。
  //    副产品：这个错会被 catch 统一包成 "Failed to resume checkpoint: ENOENT"，把"文件不存在"
  //    和"文件读到了但后续步骤炸了"混成同一条文案 —— 排查时别只信这句。
  const fullId = (prefix) => (cps[prefix]?.file || '').replace(/\.json$/, '')

  const plans = [
    ['R1 历史 + 只读追问', { messages: [...history, READONLY_CONT] }],
    ['R2 历史 + 只读追问（重跑）', { messages: [...history, READONLY_CONT] }],
    ['R3 历史 + 原始失败提问（逐字）', { messages: [...history, ORIGINAL_PROMPT] }],
    [`C1 继续检查点 ${fullId('1e9879b6').slice(0, 8)}（真实失败现场）`, { messages: [{ role: 'user', content: '继续完成这个任务。' }], resumeCheckpoint: fullId('1e9879b6') }],
    [`C2 继续检查点 ${fullId('034090c5').slice(0, 8)}（首个失败现场）`, { messages: [{ role: 'user', content: '继续完成这个任务。' }], resumeCheckpoint: fullId('034090c5') }],
  ]

  const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toUpperCase()
  const todo = only ? plans.filter(([tag]) => tag.startsWith(only)) : plans
  if (only) console.log(`  （--only=${only}，只跑 ${todo.length} 条）`)

  const t0 = Date.now()
  const results = []
  console.log('\n  形态                                    状态  tool_call  tool_res  思考轮  耗时     400?  tool_seq?')
  console.log('  ' + '─'.repeat(102))
  for (const [tag, body] of todo) {
    const r = await runOne(tag, body, SESSION_ID)
    results.push(r)
    console.log(
      `  ${tag.slice(0, 38).padEnd(40)} ${String(r.status).padEnd(5)} ` +
      `${String(r.ev.tool_call).padStart(8)}  ${String(r.ev.tool_result).padStart(8)}  ` +
      `${String(r.turnMax).padStart(5)}  ${(r.ms / 1000).toFixed(1).padStart(6)}s  ` +
      `${r.hit400 ? ' 是 ' : ' 否 '} ${r.hitToolSeq ? '   是' : '   否'}` +
      (r.err ? `  ${r.err.slice(0, 40)}` : r.errors.length ? `  ${r.errors[0].slice(0, 60)}` : '')
    )
    await new Promise((r2) => setTimeout(r2, 2000))
  }

  // ───────── 第 3 段：交叉核对（信产品自己记的，不信脚本自述）─────────
  console.log('\n── 第 3 段：task_runs 交叉核对（产品自己记的）──')
  const runs = taskRunsSince(t0 - 1000)
  console.log(`  本次新增 task_runs：${runs.length} 条`)
  for (const r of runs) {
    console.log(`  ${new Date(r.started_at).toISOString()}  ${String(r.status).padEnd(10)} ${String(r.failure_code || '-').padEnd(15)} ckpt=${String(r.checkpoint_id || '-').slice(0, 8)}  ${String(r.duration_ms ?? '-')}ms  | ${String(r.label || '').slice(0, 30)}`)
  }
  if (runs.length) {
    fs.writeFileSync('/tmp/rc-accept-created.json', JSON.stringify(runs.map((r) => r.task_id), null, 2))
    console.log(`  本次写入的 task_id 已存 /tmp/rc-accept-created.json（用 --cleanup 清理）`)
  }

  // ───────── 汇总 ─────────
  // ⚠️ "在跑工具"必须以 **tool_result 出现** 为准，不能只看 tool_call 事件：
  //    被审批闸门拦下时只会发 tool_call(pending) 而没有 tool_result → 看着像"跑了工具"，其实是卡住了。
  const withResults = results.filter((r) => r.ev.tool_call >= 1 && r.ev.tool_result >= 1)
  const multiRound = results.filter((r) => r.ev.tool_result >= 2)
  const stalled = results.filter((r) => r.stalled)
  // 续跑路径失败会被 runAgentLoop 统一包成这条文案 —— 必须单独抓，否则"没 400"会把"根本没续上"洗干净
  const resumeFailed = results.filter((r) => r.errors.some((e) => /Failed to resume checkpoint/.test(e)))
  const bad = results.filter((r) => r.hit400 || r.hitToolSeq || r.status !== 200)
  console.log('\n══ 汇总 ══')
  console.log(`  负控（原样发出应 400 RC）：${CKPTS.map(([p]) => `${p}=${cps[p]?._verdict?.raw || 'n/a'}`).join('  ')}`)
  console.log(`  正控（当前管线应 200）：  ${CKPTS.map(([p]) => `${p}=${cps[p]?._verdict?.fixed || 'n/a'}`).join('  ')}`)
  console.log(`  端到端：${results.length} 次；跑出工具结果的 ${withResults.length} 次，其中 ≥2 轮工具的 ${multiRound.length} 次`)
  console.log(`  命中 400 / tool_sequence / 非 200 的：${bad.length} 次`)
  console.log(`  疑似卡在审批（有 tool_call 无 tool_result）：${stalled.length} 次${stalled.length ? ' — ' + stalled.map((r) => r.tag).join(' / ') : ''}`)
  console.log(`  续跑路径报错（根本没续上，不是"没 400"）：${resumeFailed.length} 次${resumeFailed.length ? ' — ' + resumeFailed.map((r) => r.tag).join(' / ') : ''}`)
  console.log(`  task_runs：新增 ${runs.length} 条，其中非 completed ${runs.filter((r) => r.status !== 'completed').length} 条`)
  for (const r of runs.filter((x) => x.status !== 'completed')) {
    console.log(`    · ${r.status} ${r.failure_code || '-'} ${String(r.failure_message || '').slice(0, 120)}`)
  }
  const failed = bad.length > 0 || resumeFailed.length > 0 || runs.some((r) => r.status !== 'completed' && r.failure_code)
  console.log(`  判定：${failed ? '❌ 仍有 400/tool_sequence，需继续查' : '✅ 长会话恢复 + 多轮工具全程无 400 / 无 tool_sequence'}`)
  process.exit(failed ? 1 : 0)
}

function cleanup() {
  const p = '/tmp/rc-accept-created.json'
  if (!fs.existsSync(p)) { console.error('没有 /tmp/rc-accept-created.json，无法确定要删哪些行'); process.exit(1) }
  const ids = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (!Array.isArray(ids) || ids.length === 0) { console.error('待删列表为空'); process.exit(1) }
  const bak = path.join(process.env.HOME || '', `.supercrzy/data/supercrzy.db.bak-${Date.now()}`)
  fs.copyFileSync(DB_PATH, bak)
  console.log(`已备份：${bak}`)
  const db = new Database(DB_PATH)
  const before = db.prepare('select count(*) n from task_runs').get().n
  const placeholders = ids.map(() => '?').join(',')
  const hit = db.prepare(`select task_id from task_runs where task_id in (${placeholders})`).all(...ids)
  console.log(`边界断言：待删 ${ids.length} 条，实际命中 ${hit.length} 条`)
  if (hit.length !== ids.length) { console.error('❌ 命中数与待删数不一致，中止（避免误删）'); db.close(); process.exit(1) }
  const info = db.prepare(`delete from task_runs where task_id in (${placeholders})`).run(...ids)
  const after = db.prepare('select count(*) n from task_runs').get().n
  console.log(`删除 ${info.changes} 条；总数 ${before} → ${after}（差 ${before - after}）`)
  db.close()
  if (before - after !== ids.length) { console.error('❌ 减少量与预期不符'); process.exit(1) }
  console.log('✅ 清理完成')
}

main().catch((e) => { console.error(e); process.exit(1) })
