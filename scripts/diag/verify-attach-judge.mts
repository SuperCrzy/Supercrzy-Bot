/**
 * attach 接管判据的单元验证 (2026-09-23)
 *
 * 为什么单独验这几条：`judgeUrl` 决定"从 CDP 的 target 列表里挑哪一页接管"，
 * 其中三条结论都是**踩出来的、且反直觉**：
 *   · 空 URL 的 target 会让 `connectOverCDP` 等它初始化到 **30s 超时**
 *     （今天实测：pw:protocol 日志里那个 url="" 的 session，Page.enable/Runtime.enable
 *      一条 RECV 都没有，而另一个真页面全部正常返回）
 *   · 宿主 UI 窗口是 **http 地址**（main.cjs `mainWindow.loadURL(activeFrontUrl)`），
 *     所以"只认 http(s)"这种判据会把 App 自己的界面接管掉，症状是"AI 在用户设置页里点来点去"
 *   · 宿主排除**不能按 origin 一刀切**：原生视图的起始页和宿主 UI 同 origin（都在后端口上），
 *     按 origin 排除会把起始页自己也排掉 → attach 整体报废，而现象只是"找不到可接管页面"。
 *     所以收窄成「origin 命中 且 path 是 SPA 入口」。
 * 这三条一旦回归，都极难从现象反推原因。所以必须能**不起 Electron 就断言**。
 *
 * 跑法（tsx；用 .mts 恒为 ESM，避开根包 CJS / server ESM 的双实例坑）：
 *   cd packages/server && node node_modules/tsx/dist/cli.mjs ../../scripts/diag/verify-attach-judge.mts
 */
import { judgeUrl, browserStartPageUrl } from '../../packages/server/src/services/ai-browser.js'

interface Case { name: string; url: string; env: Record<string, string>; expectOk: boolean; whyHas?: string }
const cases: Case[] = []
const add = (name: string, url: string, expectOk: boolean, opts: { env?: Record<string, string>; whyHas?: string } = {}) =>
  cases.push({ name, url, env: opts.env || {}, expectOk, whyHas: opts.whyHas })

// ---- 规则①：空 URL（会让 connectOverCDP 卡 30s）----
add('空串', '', false, { whyHas: '空 URL' })
add('空白串', '   ', false, { whyHas: '非 http(s)' }) // 非空但非 http → 归到规则②，行为同样安全

// ---- 规则②：非 http(s)（启动占位页 / file: / about:）----
add('data: 占位页', 'data:text/html,<title>HOST-UI</title>', false, { whyHas: '非 http(s)' })
add('file: client-dist', 'file:///Applications/X.app/Contents/Resources/client-dist/index.html', false, { whyHas: '非 http(s)' })
add('about:blank', 'about:blank', false, { whyHas: '非 http(s)' })

// ---- 规则③：宿主 App 自己的 UI（**都是 http，这才是最容易被误接管的一类**）----
// ---- 规则③：显式排除项（前缀语义，排障/测试用）----
add('自定义排除项', 'http://evil.example.com/x', false, { env: { SUPERCRZY_CDP_EXCLUDE: 'http://evil.example.com' }, whyHas: '显式排除' })

// ---- 规则④：宿主 App 自己的 UI —— origin 命中**且**是 SPA 入口路径 ----
// （2026-09-23 收窄：原来是"命中 origin 即排除"，但那会连起始页一起排掉）
add('宿主 UI（后端起服，带斜杠）', 'http://127.0.0.1:3011/', false, { env: { PORT: '3011' }, whyHas: '宿主 UI' })
add('宿主 UI（无尾斜杠）', 'http://127.0.0.1:3011', false, { env: { PORT: '3011' }, whyHas: '宿主 UI' })
add('宿主 UI（localhost + hash 路由）', 'http://localhost:3011/#/chat', false, { env: { PORT: '3011' }, whyHas: '宿主 UI' })
add('宿主 UI（hash 路由到设置页）', 'http://127.0.0.1:3011/#/settings', false, { env: { PORT: '3011' }, whyHas: '宿主 UI' })
add('宿主 UI（/index.html）', 'http://127.0.0.1:3011/index.html', false, { env: { PORT: '3011' }, whyHas: '宿主 UI' })
add('宿主 UI（dev 前端 vite 5173）', 'http://127.0.0.1:5173/', false, { whyHas: '宿主 UI' })

// ---- 规则⑤：显式指定（排障用）----
add('指定匹配但目标不符', 'http://other.test/', false, { env: { SUPERCRZY_CDP_PAGE_MATCH: 'example.com' }, whyHas: '不匹配' })
add('指定匹配且命中', 'http://example.com/a', true, { env: { SUPERCRZY_CDP_PAGE_MATCH: 'example.com' } })

// ---- 本轮修复的核心：同 origin 但**非 SPA 入口**的页面必须可接管 ----
// 这就是原生视图起始页的处境：它挂在后端 3000 口上（和宿主 UI 同 origin），
// 但 path 是 /browser-start.html。旧判据把它排掉 → attach 模式一个可接管页面都没有。
add('起始页（同 origin、非 SPA 入口）', 'http://127.0.0.1:3011/browser-start.html', true, { env: { PORT: '3011' } })
add('起始页（带 query）', 'http://127.0.0.1:3011/browser-start.html?k=1', true, { env: { PORT: '3011' } })
// 同 origin 下的非根路径一律放行 —— 这是"收窄"的必然推论，写出来是为了让它成为**有意行为**而非巧合
add('同 origin 非根路径（API 响应页）', 'http://127.0.0.1:3011/api/health', true, { env: { PORT: '3011' } })

// ---- 正常应当被接管 ----
add('普通 http', 'http://127.0.0.1:54694/', true)
add('普通 https', 'https://www.baidu.com/', true)

const KEY = ['PORT', 'SUPERCRZY_CDP_EXCLUDE', 'SUPERCRZY_CDP_PAGE_MATCH']
const saved = Object.fromEntries(KEY.map((k) => [k, process.env[k]]))

let pass = 0
const fails: string[] = []
console.log('\n== attach 接管判据单元验证 ==')
for (const c of cases) {
  for (const k of KEY) delete process.env[k]
  for (const [k, v] of Object.entries(c.env)) process.env[k] = v
  const r = judgeUrl(c.url)
  const whyOk = !c.whyHas || r.why.includes(c.whyHas)
  const ok = r.ok === c.expectOk && whyOk
  if (ok) { pass++; console.log(`  [ok  ] ${c.name.padEnd(30)} ${r.ok ? '接管' : '跳过'} ← ${r.why.slice(0, 60)}`) }
  else {
    fails.push(`${c.name}: 期望 ok=${c.expectOk}${c.whyHas ? ` 且原因含"${c.whyHas}"` : ''}，实得 ok=${r.ok} why="${r.why}"`)
    console.log(`  [FAIL] ${c.name.padEnd(30)} 期望 ok=${c.expectOk} 实得 ok=${r.ok} why="${r.why}"`)
  }
}
for (const k of KEY) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }

// 不变量①：任何被判定"可接管"的 URL，都必须非空且是 http(s) —— 比逐例断言更耐久
const invariantBad = ['', 'about:blank', 'data:text/html,x', 'file:///x'].filter((u) => judgeUrl(u).ok)
if (invariantBad.length) fails.push(`不变量被破坏：这些 URL 不该被判可接管 → ${invariantBad.join(', ')}`)
else pass++

// 不变量②（本轮新增，护住那个死结）：**起始页必须自身可接管**，且宿主 SPA 入口必须被排除。
// 这两条一旦同时不成立，attach 模式就整体报废 —— 而"报废"的表现只是"找不到可接管页面"，
// 从现象反推不到"起始页被自己的排除规则排掉了"。所以钉成不变量。
process.env.PORT = '3011'
const startPage = browserStartPageUrl()
const spJudge = judgeUrl(startPage)
if (!spJudge.ok) fails.push(`不变量被破坏：起始页 ${startPage} 自己不可接管 → ${spJudge.why}（attach 会整体不可用）`)
else if (judgeUrl('http://127.0.0.1:3011/').ok) fails.push('不变量被破坏：宿主 SPA 入口本应被排除，却被判可接管')
else { pass++; console.log(`  [ok  ] 不变量：起始页可接管 且 宿主入口被排除 ← ${startPage}`) }
delete process.env.PORT

console.log(`\n== 结果：${pass} PASS / ${fails.length} FAIL ==`)
if (fails.length) { for (const f of fails) console.log(`   - ${f}`); process.exit(1) }
console.log('  ✔ 接管判据成立（空 URL、宿主 SPA 入口都会被挡掉；起始页可接管）')
process.exit(0)
