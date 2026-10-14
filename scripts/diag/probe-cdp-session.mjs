/**
 * CDP 会话级探针 (2026-09-23)
 *
 * 用途：当 Playwright 的 `connectOverCDP` 只给一句 `Timeout 30000ms exceeded` 时，
 * 手工在浏览器级 WebSocket 上重放它内部会发的命令，逐条看 Electron 回不回。
 * 这样能把"WS 握手挂住"和"握手成功但某条命令不回"这两种原因分开。
 *
 * 依赖：Node 22 自带全局 WebSocket，不需要第三方 ws 包。
 *
 * 用法（Electron 样衣需已在跑）：
 *   node scripts/diag/probe-cdp-session.mjs [port]
 */
const PORT = Number(process.argv[2] || process.env.SUPERCRZY_CDP_DEMO_PORT || 9333)
const HOST = '127.0.0.1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const version = await (await fetch(`http://${HOST}:${PORT}/json/version`)).json()
const wsUrl = version.webSocketDebuggerUrl
console.log(`\nws = ${wsUrl}`)

let id = 0
const pending = new Map()
const events = []

const ws = new WebSocket(wsUrl)
const openAt = Date.now()

const state = await new Promise((resolve) => {
  const t = setTimeout(() => resolve('HANDSHAKE_TIMEOUT'), 8000)
  ws.addEventListener('open', () => { clearTimeout(t); resolve('OPEN') })
  ws.addEventListener('error', (e) => { clearTimeout(t); resolve('ERROR ' + (e?.message || e?.type || 'unknown')) })
  ws.addEventListener('close', (e) => { clearTimeout(t); resolve(`CLOSE code=${e.code} reason=${e.reason || ''}`) })
})
console.log(`握手结果: ${state}（耗时 ${Date.now() - openAt}ms）`)
if (state !== 'OPEN') {
  console.log('\n✘ 连 WS 都没握上 —— 问题在传输层（代理/中间件/端口），不是 CDP 语义。')
  process.exit(1)
}

ws.addEventListener('message', (ev) => {
  let msg
  try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
    return
  }
  events.push(msg)
})

function send(method, params = {}, timeoutMs = 6000) {
  const mid = ++id
  return new Promise((resolve) => {
    const t = setTimeout(() => { pending.delete(mid); resolve({ __timeout: true }) }, timeoutMs)
    pending.set(mid, (m) => { clearTimeout(t); resolve(m) })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
const brief = (m) => m.__timeout ? '✘ 超时无响应' : (m.error ? `✘ error: ${m.error.message}` : '✔')

// 逐条重放 Playwright connectOverCDP 内部真正会发的命令
console.log('\n== 逐条重放 CDP 命令 ==')
const r1 = await send('Browser.getVersion')
console.log(`  Browser.getVersion        ${brief(r1)}  ${r1.result ? r1.result.product : ''}`)

const r2 = await send('Target.setDiscoverTargets', { discover: true })
console.log(`  Target.setDiscoverTargets ${brief(r2)}`)

const r3 = await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
console.log(`  Target.setAutoAttach      ${brief(r3)}   ← Playwright 卡住基本都在这条`)

const r4 = await send('Target.getTargets')
console.log(`  Target.getTargets         ${brief(r4)}  共 ${r4.result?.targetInfos?.length ?? '?'} 个`)
for (const t of r4.result?.targetInfos ?? []) {
  console.log(`      · type=${t.type} attached=${t.attached} url=${String(t.url).slice(0, 70)}`)
}

await sleep(2500)
console.log(`\n== 2.5s 内收到的事件 ${events.length} 条 ==`)
const byMethod = {}
for (const e of events) byMethod[e.method] = (byMethod[e.method] || 0) + 1
for (const [m, n] of Object.entries(byMethod)) console.log(`  ${m} × ${n}`)
const attached = events.filter((e) => e.method === 'Target.attachedToTarget')
console.log(`  Target.attachedToTarget × ${attached.length}  ← 为 0 则 Playwright 永远等不到 page`)
for (const a of attached) {
  console.log(`      · ${a.params?.targetInfo?.type} ${String(a.params?.targetInfo?.url).slice(0, 70)} sessionId=${a.params?.sessionId}`)
}

console.log('\n判读：')
console.log('  · Browser.getVersion 就超时 → WS 是"假通"（能握手，但数据通道被中间层吞）')
console.log('  · setAutoAttach 超时 → Electron 侧不响应这条命令（换 attach 方式或改用 page 级 ws）')
console.log('  · 都正常但 attachedToTarget 为 0 → 发现机制差异，需显式 Target.attachToTarget')
try { ws.close() } catch {}
process.exit(0)
