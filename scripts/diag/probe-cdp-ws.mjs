/**
 * CDP WebSocket 裸握手探针 (2026-09-23)
 *
 * 为什么需要它：Playwright 的 `connectOverCDP` 失败时只吐一句
 * `WebSocket error: socket hang up` —— 这句话把三种完全不同的故障混在一起：
 *   ① 返回了 HTTP 403（Chromium 111+ 的 Origin 校验）
 *   ② 返回了 404（路径不对 / 端口上挂的不是 DevTools）
 *   ③ TCP 被拒或连上就被 RST（中间件拦截、进程半残）
 * 不看到原始响应行和响应头，就没法判断该改代码还是该改环境。
 *
 * 本脚本做三件事：
 *   A. 读 /json/version 与 /json/list，打印 webSocketDebuggerUrl
 *   B. 对 browser 级 ws 路径做裸 HTTP Upgrade，打印状态行 + 全部响应头
 *   C. 分别试「不带 Origin」和「带 Origin: devtools://devtools」，对照出 403 的触发条件
 *
 * 用法（Electron 样衣需已在跑；见 cdp-demo.cjs）：
 *   node scripts/diag/probe-cdp-ws.mjs [port]
 */
import net from 'node:net'

const PORT = Number(process.argv[2] || process.env.SUPERCRZY_CDP_DEMO_PORT || 9333)
const HOST = '127.0.0.1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getJson(path) {
  try {
    const r = await fetch(`http://${HOST}:${PORT}${path}`)
    if (!r.ok) return { __status: r.status }
    return await r.json()
  } catch (e) {
    // ⚠️ 别只打 e.message —— undici 对连接类失败只给一句 "fetch failed"，
    //    真因在 e.cause 里（ECONNREFUSED / ECONNRESET / …）。只打 message 会把
    //    「端口没人听」「进程已崩」这两种完全不同的情况糊成同一句话。
    const cause = e?.cause
    return {
      __err: String(e?.message || e),
      __cause: cause ? `${cause.code || cause.name || ''} ${cause.message || ''}`.trim() : undefined,
    }
  }
}

/** 裸握手：只发 HTTP Upgrade，把服务端第一段原始响应原样带回来 */
function rawUpgrade(wsPath, originHeader) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, HOST)
    const chunks = []
    let settled = false
    const done = (tag, extra) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch {}
      const head = Buffer.concat(chunks).toString('latin1').split('\r\n\r\n')[0]
      resolve({ tag, head, extra })
    }
    sock.setTimeout(6000)
    sock.on('connect', () => {
      const lines = [
        `GET ${wsPath} HTTP/1.1`,
        `Host: ${HOST}:${PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
      ]
      if (originHeader) lines.push(`Origin: ${originHeader}`)
      sock.write(lines.join('\r\n') + '\r\n\r\n')
    })
    sock.on('data', (d) => {
      chunks.push(d)
      // 收到第一个完整头段就够判定了
      if (Buffer.concat(chunks).toString('latin1').includes('\r\n\r\n')) done(originHeader ? 'with-origin' : 'no-origin')
    })
    sock.on('timeout', () => done('timeout'))
    sock.on('error', (e) => done('error', e.code || e.message))
    sock.on('close', (hadErr) => done('closed', hadErr ? 'had-error' : 'clean-close'))
  })
}

const version = await getJson('/json/version')
console.log('\n== A. /json/version ==')
console.log(JSON.stringify(version, null, 2))

if (!version || !version.webSocketDebuggerUrl) {
  console.log('\n✘ 拿不到 webSocketDebuggerUrl，后面的握手没法做。')
  process.exit(1)
}

const list = await getJson('/json/list')
console.log('\n== B. /json/list（Playwright 要靠它发现 target）==')
if (Array.isArray(list)) {
  console.log(`  共 ${list.length} 个 target`)
  for (const t of list) {
    console.log(`   · type=${t.type} url=${String(t.url).slice(0, 90)}`)
    console.log(`     ws=${t.webSocketDebuggerUrl || '(无)'}`)
  }
} else {
  console.log('  ' + JSON.stringify(list))
}

const wsPath = new URL(version.webSocketDebuggerUrl).pathname
console.log(`\n== C. 裸 Upgrade 到 ${wsPath} ==`)
for (const origin of [null, 'devtools://devtools', `http://${HOST}:${PORT}`]) {
  const label = origin ? `Origin: ${origin}` : '(不带 Origin)'
  const r = await rawUpgrade(wsPath, origin)
  const first = (r.head || '').split('\r\n')[0] || `(空响应 head=${r.tag} extra=${r.extra || ''})`
  const headers = (r.head || '').split('\r\n').slice(1).filter(Boolean)
  console.log(`\n  --- ${label} [${r.tag}] ---`)
  console.log(`  ${first}`)
  for (const h of headers) console.log(`  ${h}`)
  await sleep(150)
}

console.log('\n判读要点：101 = 通；403 = Origin 校验（要在 Electron 侧放开 remote-allow-origins）；')
console.log('         hang up / clean-close 且无响应行 = 连接被中间层掐断，不是协议问题。\n')
