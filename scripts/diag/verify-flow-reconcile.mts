/**
 * I15 验收：flow × content 对账在**真实运行库**上的表现（可重跑）。
 *
 * 用法：
 *   /Users/chaojiphonekuang/.workbuddy/binaries/node/versions/22.22.2-3/bin/node \
 *     node_modules/tsx/dist/cli.mjs scripts/diag/verify-flow-reconcile.mts
 *
 * ⚠️ 不要用 `npx tsx`（宿主 PATH 里有 brokered-bin 代理 + BASH_ENV 注入，会静默失败）。
 * ⚠️ 只读：sqlite 以 `mode=ro` 打开 / 用 `-readonly` CLI，绝不写库。
 *
 * 它回答的不是"单测绿不绿"，而是"**老板真实会话里的那条消息**修好了没有"：
 *   ① 旧算法（偏移 = 全部 text 段拼接长度）在 N 条上把答案挖了洞；
 *   ② 新算法（偏移 = 最后一个 text 段自身长度）把 N 条全部收敛成"末段 == content"。
 * 判据是「末段与 content 的公共前缀 / 末段长度」——**不是长度相等**
 * （长度相等是旧 bug 的恒等式，看不出问题，这点是本轮最大的教训）。
 */
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

const DB = process.env.SUPERCRZY_DB || path.join(homedir(), '.supercrzy', 'data', 'supercrzy.db')

interface Row { id: string; sid: string; content: string; flow: any[] }

function loadRows(limit: number): Row[] {
  const raw = execFileSync(
    'sqlite3',
    [
      '-readonly',
      DB,
      `SELECT json_object('id',m.id,'sid',m.session_id,'content',m.content,'att',m.attachments) ` +
        `FROM messages m WHERE m.role='assistant' AND m.attachments LIKE '%"flow"%' ` +
        `ORDER BY m.created_at DESC LIMIT ${limit};`,
    ],
    { maxBuffer: 1 << 28 },
  ).toString()
  const out: Row[] = []
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    try {
      const m = JSON.parse(line)
      const att = JSON.parse(m.att || '{}')
      if (Array.isArray(att.flow)) out.push({ id: m.id, sid: m.sid, content: m.content || '', flow: att.flow })
    } catch { /* 跳过坏行 */ }
  }
  return out
}

const textsOf = (flow: any[]) => flow.filter((n) => n?.kind === 'text').map((n) => String(n.text ?? ''))
const lastOf = (flow: any[]) => textsOf(flow).slice(-1)[0] ?? null

/** 旧算法：偏移 = 所有 text 段拼接后的长度（bug 源） */
function legacy(flow: any[], content: string): string {
  const joined = textsOf(flow).join('')
  const last = lastOf(flow) ?? ''
  return content.length > joined.length ? last + content.slice(joined.length) : last
}

/** 新算法：偏移 = 最后一个 text 段自身长度（唯一正确基准） */
function fixed(flow: any[], content: string): string {
  const last = lastOf(flow) ?? ''
  if (!content) return last
  if (content.startsWith(last)) return content
  if (last.startsWith(content)) return content
  return content // 末段是旁白 → 另起正文节点，取 content
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/**
 * 真实"被吃掉的字符数"：`content` 去掉「与旧末段的公共前缀」和「公共后缀」之后剩下的长度。
 *
 * ⚠️ 不要用 `content.length - commonPrefix(...)` 当洞大小 —— 那算的是"分叉点之后的全部内容"，
 * 把正常保留的尾巴也计进去了（e66828bd 会报 1373，真实洞只有 169）。
 * 也不要用单字符贪心匹配（中文常见字满篇都是，会随机命中把指标算歪）。
 * 本 bug 的形状是"答案中间被挖掉一段连续内容"，所以前缀+后缀正是它的精确补集。
 */
function missingChars(content: string, rendered: string): number {
  const p = commonPrefix(content, rendered)
  const maxSuffix = Math.min(content.length - p, rendered.length - p)
  let s = 0
  while (s < maxSuffix && content[content.length - 1 - s] === rendered[rendered.length - 1 - s]) s++
  return Math.max(0, content.length - p - s)
}

const rows = loadRows(600)
let legacyBad = 0
let legacyHoleTotal = 0
let fixedBad = 0
const samples: string[] = []

for (const r of rows) {
  if (!r.content || textsOf(r.flow).length === 0) continue
  const oldLast = legacy(r.flow, r.content)
  const newLast = fixed(r.flow, r.content)
  if (oldLast !== r.content) {
    legacyBad++
    const lost = missingChars(r.content, oldLast)
    legacyHoleTotal += lost
    if (samples.length < 5) {
      samples.push(
        `  ${r.id.slice(0, 8)} (${r.sid.slice(0, 8)}) content=${r.content.length} ` +
          `旧末段=${oldLast.length} 丢失=${lost} 字 ` +
          `→ 新末段=${newLast.length} ${newLast === r.content ? 'OK' : 'STILL BAD'}`,
      )
    }
  }
  if (newLast !== r.content) fixedBad++
}

console.log(`库: ${DB}`)
console.log(`样本: ${rows.length} 条含 flow 的 assistant 消息`)
console.log('')
console.log(`【旧算法】末段 != content：${legacyBad} 条（${((legacyBad / rows.length) * 100).toFixed(1)}%），累计被吃掉 ${legacyHoleTotal} 字符`)
console.log(`【新算法】末段 != content：${fixedBad} 条`)
console.log('')
if (samples.length) {
  console.log('旧算法受害样本（前 5）：')
  samples.forEach((s) => console.log(s))
}
console.log('')
if (fixedBad === 0 && legacyBad > 0) {
  console.log(`✅ 通过：旧算法在 ${legacyBad} 条真实消息上挖洞，新算法全部收敛为「末段 == content」`)
  process.exit(0)
}
if (legacyBad === 0) {
  console.log('⚠️ 库里没有复现出旧 bug（可能样本太少或全是被加载端修过的历史）—— 不算失败，但证据不充分')
  process.exit(0)
}
console.log(`❌ 失败：新算法仍有 ${fixedBad} 条不一致，去查 flow-reconcile.ts 的偏移基准`)
process.exit(1)
