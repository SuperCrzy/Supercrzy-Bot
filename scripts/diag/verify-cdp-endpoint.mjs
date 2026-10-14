/**
 * CDP 端点发现的单元验证（2026-09-23）
 *
 * 为什么单独验：`cdp-endpoint.cjs` 的几条结论全是"错了很难看出来"的类型 ——
 *   · 端口文件是**异步写**的 → 不轮询就永远读不到，表现为"attach 随机不可用"
 *   · 端口文件是**跨运行残留**的 → 读到过期端口，表现为"连上了但接的是死端口/别的实例"
 *     （这里刻意用 `utimesSync` 把 mtime 改到 1 小时前来**真实模拟**残留文件，
 *      而不是断言"我们删了它" —— 断行为，不断实现）
 *   · 读不到端口时必须**回落 launch** → 否则每次操作都抛"找不到可接管页面"，比原来更差
 *   · 只给 `BROWSER_MODE=attach` 不给端点 → 后端会去连默认 9333（一个没人听的端口）
 * 这几条只要靠 Electron 才能验，就没人会验。所以拆出纯函数，这里钉死。
 *
 * 跑法（纯 node，不需要 Electron）：
 *   node scripts/diag/verify-cdp-endpoint.mjs
 */
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const mod = require(path.resolve(HERE, '../../packages/desktop/cdp-endpoint.cjs'))

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  [ok  ] ${name}${detail ? ' ← ' + detail : ''}`) }
  else { fails.push(`${name}${detail ? ' ← ' + detail : ''}`); console.log(`  [FAIL] ${name}${detail ? ' ← ' + detail : ''}`) }
}
const eq = (name, got, want) => ok(name, Object.is(got, want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
/** 始终视为"活着的"探针 / 始终视为"死的"探针（注入用，避免测试依赖真端口） */
const probeAlive = async () => true
const probeDead = async () => false

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-cdp-ep-'))
const writePortFile = (dir, content) => fs.writeFileSync(path.join(dir, mod.PORT_FILE), content)
const backdate = (dir, msAgo) => {
  const t = new Date(Date.now() - msAgo)
  fs.utimesSync(path.join(dir, mod.PORT_FILE), t, t)
}
const mkdir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d }

const ENV_KEYS = ['SUPERCRZY_CDP_OFF', 'SUPERCRZY_CDP_ENDPOINT']
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const clearEnv = () => { for (const k of ENV_KEYS) delete process.env[k] }

console.log('\n== CDP 端点发现 ==')

// ---- ① 解析 DevToolsActivePort ----
console.log('\n-- 解析（Chromium 自己写的内容）--')
const p1 = mod.parseDevToolsActivePort('54694\n/devtools/browser/abc-def\n')
eq('两行标准内容 → port', p1 && p1.port, 54694)
eq('两行标准内容 → wsPath', p1 && p1.wsPath, '/devtools/browser/abc-def')
eq('CRLF', (mod.parseDevToolsActivePort('54694\r\n/x\r\n') || {}).port, 54694)
eq('只有端口行（wsPath 缺失不致命）', (mod.parseDevToolsActivePort('54694') || {}).wsPath, '')
eq('前后空白/空行容错', (mod.parseDevToolsActivePort('\n  54694  \n\n') || {}).port, 54694)
for (const [name, input] of [
  ['空串', ''], ['null', null], ['全空白', '   \n  \n'],
  ['非数字', 'abc\n/x'], ['端口 0', '0\n/x'], ['负数', '-1\n/x'],
  ['超范围 70000', '70000\n/x'], ['小数', '1.5\n/x'],
]) eq(`拒绝：${name}`, mod.parseDevToolsActivePort(input), null)

// ---- ② 新鲜度判定（本次启动写的 vs 上次残留）----
console.log('\n-- 新鲜度（残留端口 = 连到死端口/别的实例）--')
const dFresh = mkdir('fresh')
const dStale = mkdir('stale')
const dMissing = mkdir('missing')
writePortFile(dFresh, '51001\n/devtools/browser/a\n')
writePortFile(dStale, '51002\n/devtools/browser/b\n')
backdate(dStale, 3600_000) // 真实地把 mtime 改到 1 小时前

eq('不存在 → state', mod.readPortFile(dMissing, { sinceMs: Date.now() }).state, 'missing')
eq('内容不可解析 → state', (() => {
  const d = mkdir('unusable'); writePortFile(d, 'not-a-port\n')
  return mod.readPortFile(d, { sinceMs: Date.now() }).state
})(), 'unusable')
eq('刚写的 → fresh', mod.readPortFile(dFresh, { sinceMs: Date.now() }).state, 'fresh')
eq('1 小时前的残留 → stale', mod.readPortFile(dStale, { sinceMs: Date.now() }).state, 'stale')
eq('不传 sinceMs 时不做新鲜度判断（调用方可显式跳过该判据）', mod.readPortFile(dStale, { sinceMs: 0 }).state, 'fresh')

// ---- ③ 等待：超时 / 晚写 / 残留被忽略 / 探活 ----
console.log('\n-- 等待（异步写入 + 残留 + 探活）--')
const t0 = Date.now()
const rMiss = await mod.waitForCdpPort(dMissing, { timeoutMs: 300, intervalMs: 50, sinceMs: Date.now(), probe: probeAlive })
ok('文件始终不出现 → 超时返回 found=null（不抛异常）', rMiss.found === null, `${Date.now() - t0}ms`)
ok('超时 reason 里带状态（可排障）', rMiss.reason.includes('state=missing'), rMiss.reason)

// 关键用例：文件 150ms 后才出现，只有真的轮询才能拿到
const dLate = mkdir('late')
const sinceLate = Date.now()
const pending = mod.waitForCdpPort(dLate, { timeoutMs: 3000, intervalMs: 50, sinceMs: sinceLate, probe: probeAlive })
setTimeout(() => writePortFile(dLate, '41234\n/devtools/browser/late\n'), 150)
const rLate = await pending
eq('150ms 后才写入 → 仍能等到（证明真的在轮询）', rLate.found && rLate.found.port, 41234)

// 关键用例：残留文件在，但本次的还没写 → 必须继续等，不能拿残留凑数
const dStaleOnly = mkdir('stale-only')
writePortFile(dStaleOnly, '11111\n/devtools/browser/old\n')
backdate(dStaleOnly, 3600_000)
const rStaleOnly = await mod.waitForCdpPort(dStaleOnly, { timeoutMs: 300, intervalMs: 50, sinceMs: Date.now(), probe: probeAlive })
ok('只有残留文件 → 不拿它凑数（found=null）', rStaleOnly.found === null)
ok('只有残留文件 → reason 说明是 stale', rStaleOnly.reason.includes('state=stale'), rStaleOnly.reason)

// 关键用例：残留 + 稍后写入新的 → 必须拿到**新的那个端口**（而不是残留的 11111）
const dStaleThenNew = mkdir('stale-then-new')
writePortFile(dStaleThenNew, '11111\n/devtools/browser/old\n')
backdate(dStaleThenNew, 3600_000)
const sinceSTN = Date.now()
const pending2 = mod.waitForCdpPort(dStaleThenNew, { timeoutMs: 3000, intervalMs: 50, sinceMs: sinceSTN, probe: probeAlive })
setTimeout(() => writePortFile(dStaleThenNew, '22222\n/devtools/browser/new\n'), 150)
const rSTN = await pending2
eq('残留 + 稍后新写 → 拿到新端口（不接死端口）', rSTN.found && rSTN.found.port, 22222)

// 探活：端口文件新、但端点没响应 → 不能算成功
const dDead = mkdir('dead')
writePortFile(dDead, '33333\n/devtools/browser/dead\n')
const rDead = await mod.waitForCdpPort(dDead, { timeoutMs: 300, intervalMs: 50, sinceMs: Date.now(), probe: probeDead })
ok('探活失败 → found=null', rDead.found === null)
ok('探活失败 → reason 标明 probe-failed 且带端口', rDead.reason.includes('probe-failed') && rDead.reason.includes('33333'), rDead.reason)
const rAlive = await mod.waitForCdpPort(dDead, { timeoutMs: 300, intervalMs: 50, sinceMs: Date.now(), probe: probeAlive })
eq('探活成功 → 采用', rAlive.found && rAlive.found.port, 33333)

// ---- ④ 端点拼装（CDP 绝不能对外）----
console.log('\n-- 端点 --')
eq('端点形态', mod.cdpEndpoint(54694), 'http://127.0.0.1:54694')
ok('端点恒为 127.0.0.1（CDP = 整个 App 的 JS 执行权，不能暴露）',
  !/0\.0\.0\.0|\[::\]/.test(mod.cdpEndpoint(1)))

// ---- ⑤ attach env 决策（失败必须回落 launch）----
console.log('\n-- attach env 决策 --')
clearEnv()
const rOff = await mod.resolveAttachEnv({ userDataDir: dFresh, enabled: false })
eq('enabled=false → BROWSER_MODE', rOff.env.BROWSER_MODE, 'launch')
eq('enabled=false → ok', rOff.ok, false)

process.env.SUPERCRZY_CDP_OFF = '1'
const rDisabled = await mod.resolveAttachEnv({ userDataDir: dFresh, probe: probeAlive })
eq('SUPERCRZY_CDP_OFF=1 → launch', rDisabled.env.BROWSER_MODE, 'launch')
ok('SUPERCRZY_CDP_OFF=1 时不带端点', rDisabled.env.SUPERCRZY_CDP_ENDPOINT === undefined)
clearEnv()

const rNoDir = await mod.resolveAttachEnv({ userDataDir: '' })
eq('缺 userDataDir → launch', rNoDir.env.BROWSER_MODE, 'launch')

// 关键用例：读不到端口 → 必须显式写 launch（不能只"不传"，否则继承来的 attach 会留下）
const rTimeout = await mod.resolveAttachEnv({ userDataDir: dMissing, timeoutMs: 200, sinceMs: Date.now(), probe: probeAlive })
eq('读不到端口 → 显式 BROWSER_MODE=launch', rTimeout.env.BROWSER_MODE, 'launch')
eq('读不到端口 → ok=false', rTimeout.ok, false)
ok('读不到端口 → reason 里带上文件路径（可排障）', rTimeout.reason.includes(mod.PORT_FILE), rTimeout.reason.slice(0, 80))

// 操作者自己设了端点（排障路径）：不要覆盖他的选择
process.env.SUPERCRZY_CDP_ENDPOINT = 'http://127.0.0.1:9222'
const rOperator = await mod.resolveAttachEnv({ userDataDir: dMissing, timeoutMs: 200, sinceMs: Date.now(), probe: probeAlive })
eq('操作者已显式设端点 → env 空（不覆盖）', Object.keys(rOperator.env).length, 0)
clearEnv()

// 成功路径
const rOk = await mod.resolveAttachEnv({ userDataDir: dFresh, timeoutMs: 500, sinceMs: Date.now(), probe: probeAlive })
eq('成功 → ok', rOk.ok, true)
eq('成功 → BROWSER_MODE', rOk.env.BROWSER_MODE, 'attach')
eq('成功 → 端点', rOk.env.SUPERCRZY_CDP_ENDPOINT, 'http://127.0.0.1:51001')
eq('成功 → port 回传', rOk.port, 51001)

// 不变量：attach 的 env 要么两个键都在，要么一个都不要
ok('不变量：attach env 必须成对出现（BROWSER_MODE + SUPERCRZY_CDP_ENDPOINT）',
  !!rOk.env.BROWSER_MODE && !!rOk.env.SUPERCRZY_CDP_ENDPOINT)
ok('不变量：非 ok 时绝不能只给端点不给模式（否则后端去连默认 9333）',
  !(rTimeout.env.SUPERCRZY_CDP_ENDPOINT && !rTimeout.env.BROWSER_MODE))

for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log(`\n== 结果：${pass} PASS / ${fails.length} FAIL ==`)
if (fails.length) { for (const f of fails) console.log(`   - ${f}`); process.exit(1) }
console.log('  ✔ 端点发现成立（轮询等待 / 忽略残留 / 探活 / 失败回落 launch）')
process.exit(0)
