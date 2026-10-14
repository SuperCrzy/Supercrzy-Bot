/**
 * 记忆整理端到端验证（#147 记忆系统整理机制，2026-09-18）
 *
 * 跑法：cd packages/server && node node_modules/tsx/dist/cli.mjs scripts/verify-memory-consolidate.ts
 *
 * 为什么需要它：单测用的是合成数据，**跑得过不代表真库上是对的**。
 * 本脚本在**真实库的副本**上跑完整链路（迁移 → 整理 → 复跑），验证四个只有真数据才能暴露的性质：
 *   ① 迁移能把历史脏分类（经验 / fact / 大小写）收敛到现行枚举
 *   ② 整理报表的数字与实际落库结果**一致**（曾出现"报表说归并 21 条、总量却写 213→213"）
 *   ③ 幸存者的价值标记未被降级、使用热度已累加（★核心不变量）
 *   ④ 一次整理即到不动点（复跑零变化），且任一行不跨组
 *
 * 历史战绩：这个脚本抓出了两个单测全绿却真实存在的 bug ——
 *   跨轮接力时「统计量陈旧」（重要性被降级、使用热度丢失）与「报表指向已删行」。
 * 改动整理逻辑后请务必重跑它。
 *
 * ⚠️ 只在 /tmp 的副本上操作，绝不碰 ~/.supercrzy/data/supercrzy.db
 */
import { copyFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 不许写死开发机的绝对路径
const SRC = join(homedir(), '.supercrzy', 'data', 'supercrzy.db')
const COPY = '/tmp/supercrzy-verify/copy.db'
mkdirSync('/tmp/supercrzy-verify', { recursive: true })
copyFileSync(SRC, COPY)
console.log(`已复制真实库到 ${COPY}\n`)

// 让 initDatabase 指向副本（config 的 resolveDbPath 尊重显式 DB_PATH）
process.env.DB_PATH = COPY

const { initDatabase, getDB } = await import('../src/services/database.js')
const { consolidateMemories, CATEGORY_CAP } = await import('../src/services/memory-consolidate.js')
const { MEMORY_CATEGORIES } = await import('../src/services/memory-category.js')

const dist = (db: any) =>
  (db.prepare('SELECT category, COUNT(*) n FROM agent_memory GROUP BY category ORDER BY n DESC').all() as any[])
    .map((r) => `${r.category}=${r.n}`).join('  ')
const total = (db: any) => (db.prepare('SELECT COUNT(*) n FROM agent_memory').get() as any).n

const pre = new (Database as any)(COPY)
console.log('=== 迁移前 ===')
console.log(`  ${dist(pre)}`)
console.log(`  总量 ${total(pre)}`)
const dirtyBefore = (pre.prepare(
  `SELECT COUNT(*) n FROM agent_memory WHERE category NOT IN (${MEMORY_CATEGORIES.map((c) => `'${c}'`).join(',')})`,
).get() as any).n
console.log(`  非法分类行数: ${dirtyBefore}`)
pre.close()

initDatabase()
const db = getDB()

console.log('\n=== 迁移后（initDatabase 已跑）===')
console.log(`  ${dist(db)}`)
const dirtyAfter = (db.prepare(
  `SELECT COUNT(*) n FROM agent_memory WHERE category NOT IN (${MEMORY_CATEGORIES.map((c) => `'${c}'`).join(',')})`,
).get() as any).n
console.log(`  非法分类行数: ${dirtyAfter}  ${dirtyAfter === 0 ? '✅ 全部收敛' : '❌ 仍有残留'}`)

// 整理前快照：用于验证「合并后幸存者不丢价值标记」这个**真正**的不变量。
// 注意不能拿"importance>=5 的行数"当指标 —— 合并本来就要减少行数，
// 行数下降 ≠ 价值丢失。正确的问法是：被删掉的那些行，其 importance 有没有超过幸存者？
const snapBefore = new Map<string, { imp: number; conf: number; use: number }>(
  (db.prepare('SELECT id, importance, confidence, usage_count FROM agent_memory').all() as any[])
    .map((r) => [r.id, { imp: r.importance, conf: r.confidence, use: r.usage_count }]),
)
const highBefore = (db.prepare('SELECT COUNT(*) n FROM agent_memory WHERE importance >= 5').get() as any).n

// ── 工具层验证（放在真实整理**之前**：此时库里还有待整理项，
//    才能验到"有发现时"的完整文案；整理完再跑就只剩"已经足够干净"了）──
console.log('\n=== 工具层（memory_consolidate.execute）===')
const toolMod = await import('../src/tools/memory-consolidate.js')
const countBeforeTool = total(db)
const toolOut = String(await (toolMod.default.execute as any)({ dryRun: true }, {}))
console.log(toolOut.split('\n').slice(0, 5).map((l: string) => `  ${l}`).join('\n'))
console.log(`  …（共 ${toolOut.split('\n').length} 行）`)
console.log(`  dryRun 零写入: ${total(db) === countBeforeTool ? '✅' : '❌'}`)
console.log(`  文案含"试算"与执行指引: ${/试算/.test(toolOut) && /dryRun=false/.test(toolOut) ? '✅' : '❌'}`)
// 记忆开关关闭时必须拒绝（与 memory_store 同契约）
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('memoryEnabled', 'false')").run()
console.log(`  记忆关闭时拒绝: ${/已关闭/.test(String(await (toolMod.default.execute as any)({ dryRun: true }, {}))) ? '✅' : '❌'}`)
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('memoryEnabled', 'true')").run()

console.log('\n=== 整理（真实执行）===')
const before = total(db)
const rep = consolidateMemories(db, {})
console.log(`  ${rep.summary}`)
console.log(`  合并迭代 ${rep.mergePasses} 轮才到不动点`)
console.log(`  实际总量 ${before} → ${total(db)}  ${total(db) === rep.after ? '✅ 报表与实际一致' : '❌ 报表与实际不符'}`)

// ★核心不变量：每个幸存者的 importance/usage 不得低于它吸收掉的任何一行
let violated = 0
for (const g of rep.mergedGroups) {
  const winner = db.prepare('SELECT importance, confidence, usage_count FROM agent_memory WHERE id = ?')
    .get(g.winnerId) as any
  if (!winner) { console.log(`  ❌ 幸存者 ${g.winnerKey} 不存在（内容已丢）`); violated++; continue }
  for (const m of g.merged) {
    const src = snapBefore.get(m.id)
    if (!src) continue
    if (winner.importance < src.imp) { console.log(`  ❌ ${g.winnerKey} importance ${winner.importance} < 被并入的 ${src.imp}`); violated++ }
    if (winner.confidence < src.conf) { console.log(`  ❌ ${g.winnerKey} confidence 下降`); violated++ }
  }
  const expectUsage = (snapBefore.get(g.winnerId)?.use ?? 0) + g.merged.reduce((n, m) => n + (snapBefore.get(m.id)?.use ?? 0), 0)
  if (winner.usage_count !== expectUsage) { console.log(`  ❌ ${g.winnerKey} usage ${winner.usage_count} ≠ 期望 ${expectUsage}`); violated++ }
}
console.log(`\n=== 价值保全（★核心不变量）===`)
console.log(`  幸存者价值标记未被降级、使用热度已累加: ${violated === 0 ? '✅ 全部满足' : `❌ ${violated} 处违规`}`)
console.log(`  importance>=5 行数: ${highBefore} → ${(db.prepare('SELECT COUNT(*) n FROM agent_memory WHERE importance >= 5').get() as any).n}`)
console.log(`  （行数下降是合并的预期结果：同主题的重复行合并为一条，非价值丢失）`)

console.log('\n=== 整理后分布 ===')
console.log(`  ${dist(db)}`)
console.log(`  上限: ${Object.entries(CATEGORY_CAP).map(([c, n]) => `${c}≤${n}`).join(' ')}`)
const overCap = (db.prepare(
  `SELECT category, COUNT(*) n FROM agent_memory GROUP BY category HAVING n > 100 ORDER BY n DESC`,
).all() as any[])
console.log(`  超上限分类: ${overCap.length === 0 ? '无 ✅' : JSON.stringify(overCap)}`)

// 幂等：迭代到不动点后，再跑一次应当零变化
const again = consolidateMemories(db, {})
console.log(`\n=== 幂等复跑 ===`)
console.log(`  ${again.summary}  ${again.removed === 0 ? '✅ 已收敛（一次整理即到位）' : '⚠️ 仍有可整理项'}`)

// 不变量：任一行不得跨组
const seen = new Map<string, number>()
for (const g of rep.mergedGroups) {
  for (const id of [g.winnerId, ...g.merged.map((m) => m.id)]) seen.set(id, (seen.get(id) ?? 0) + 1)
}
const dup = [...seen.entries()].filter(([, n]) => n > 1)
console.log(`  不变量（任一行不跨组）: ${dup.length === 0 ? '✅ OK' : `❌ ${JSON.stringify(dup)}`}`)

console.log('\n=== 副本清理 ===')
db.close()
if (existsSync(COPY)) unlinkSync(COPY)
console.log('  已删除副本；真实库未被触碰')
