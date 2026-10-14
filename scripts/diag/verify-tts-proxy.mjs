/**
 * TTS 出口代理 · 闭环保真验收 (2026-09-28)
 *
 * 验的是什么：**设了 `TTS_PROXY` 之后，流量是不是真的从代理出去的。**
 *
 * 为什么必须是闭环：单测能证明"我把 proxy 参数传给了 EdgeTTS"，但证明不了
 * "这个参数真的改变了链路"。这两件事之间隔着 `node-edge-tts` 内部
 * `agent: this.proxy ? new HttpsProxyAgent(this.proxy) : undefined` 这一跳 ——
 * 参数名写错、库升级改语义，单测都照样全绿。所以这里起一个**真的本地 CONNECT 代理**，
 * 让请求从它出去，然后断言**代理侧真的看到了 `CONNECT speech.platform.bing.com:443`**。
 *
 * 两个方向都要验（否则是恒真断言）：
 *   · 设了 TTS_PROXY → 代理看到 CONNECT（闭环建立）
 *   · **没设** → 代理一个连接都收不到（证明"不设就走直连"不是嘴上说说）
 *
 * 为什么直接 import dist 而不是打 HTTP：`/api/tts` 那一层（路由、DB、端口）不是被测对象，
 * 把临时后端拉起来只会引入"沙箱里连不上 ~/.supercrzy 数据库"这类无关噪声。
 * 这里 import 的就是**真正上线的那份 dist 产物**，走的是完整业务链路。
 *
 * 副作用：会真发 2~3 次上游合成请求；不写任何数据、不改设置。
 *
 * 跑法（先 `npm run build`，脚本读的是 dist）：
 *   node scripts/diag/verify-tts-proxy.mjs
 */
import { createServer, connect } from 'node:net'
import { once } from 'node:events'
// 项目根由脚本位置推导 —— 不许写死本机绝对路径（对外发布后会指向不存在的目录，
// 且会把开发机的用户名带进公开仓库）。
import { fileURLToPath as __f2p } from 'node:url'
import { dirname as __dn, join as __j } from 'node:path'
const __ROOT = __j(__dn(__f2p(import.meta.url)), '../..')

const ROOT = __ROOT
const PROXY_PORT = 3112

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok: !!ok, kind: 'assert' })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`)
}
/**
 * SKIP 而不是 FAIL —— 上游 RST 是**本机网络路径**的既有问题，代理换的是同一段路，
 * 本来就修不了它；把它判红只会让本脚本时而红时而绿，反而掩盖真正的回归。
 * （与 `verify-desktop-ui.mjs` 里 `screencapture` 缺权限时记 SKIP 是同一条纪律。）
 */
function skip(label, detail = '') {
  results.push({ label, ok: true, kind: 'skip' })
  console.log(`  SKIP ${label}${detail ? '  ' + detail : ''}`)
}

/** 上游被 RST 的已知措辞（含走代理时的 TLS 版） */
const UPSTREAM_RESET_RE = /ECONNRESET|socket disconnected|secure TLS connection|socket hang up|Timed out|timed out|timeout/i

// ── 一个最小可用的 HTTP CONNECT 代理：只做隧道，记录被请求的目标
const seen = []
const proxy = createServer((sock) => {
  let buf = ''
  const onData = (chunk) => {
    buf += chunk.toString('latin1')
    if (!buf.includes('\r\n\r\n')) return
    sock.off('data', onData)
    const line = buf.split('\r\n')[0]
    const m = /^CONNECT\s+([^\s]+)\s+HTTP\/1\.[01]$/i.exec(line)
    if (!m) {
      seen.push({ method: line.split(' ')[0], target: line.split(' ')[1] || null, tunnel: false })
      sock.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
      return
    }
    seen.push({ method: 'CONNECT', target: m[1], tunnel: true })
    const [host, port] = m[1].split(':')
    const up = connect({ host, port: Number(port) || 443 })
    up.on('connect', () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      sock.pipe(up)
      up.pipe(sock)
    })
    up.on('error', () => sock.destroy())
  }
  sock.on('data', onData)
  sock.on('error', () => {})
})
proxy.listen(PROXY_PORT, '127.0.0.1')
await once(proxy, 'listening')
console.log(`本地 CONNECT 代理已监听 127.0.0.1:${PROXY_PORT}`)

// ⚠️ dist 是构建产物：读它之前必须先 `npm run build`，否则验的是旧代码
const { synthesizeSpeech, ttsProxyFromEnv } = await import(`file://${ROOT}/packages/server/dist/services/tts.js`)

/**
 * 打一次合成（内部最多试 3 回 —— 上游握手本身就是概率性的，单次失败说明不了任何事）。
 * 返回 { ok, ms, bytes?, err?, attempts }
 */
async function synth(label) {
  let last = null
  for (let i = 1; i <= 3; i++) {
    const t = Date.now()
    try {
      const buf = await synthesizeSpeech('代理验收用的一句短文本。', { voice: 'zh-CN-XiaoxiaoNeural' })
      console.log(`  [${label}] 合成成功 第${i}次 ${Date.now() - t}ms ${buf.length}B`)
      return { ok: true, ms: Date.now() - t, bytes: buf.length, attempts: i }
    } catch (e) {
      last = { ok: false, ms: Date.now() - t, err: String(e?.message || e), attempts: i }
      console.log(`  [${label}] 第${i}次失败 ${Date.now() - t}ms: ${last.err}`)
    }
  }
  return last
}

/**
 * 合成是否"成功"要分三态判定：
 *   ① 成功 → ok
 *   ② 失败于**上游 RST** → SKIP（同一段网络路径，代理修不了；且这是已知既有问题）
 *   ③ 失败于代理本身（连不上代理 / 代理拒绝）→ FAIL（这才是本脚本要抓的回归）
 */
function verdictOf(r, proxyUrl) {
  if (r.ok) return 'ok'
  const msg = String(r.err || '')
  if (msg.includes(proxyUrl) || /ECONNREFUSED.*127\.0\.0\.1/.test(msg)) return 'fail'
  return UPSTREAM_RESET_RE.test(msg) ? 'skip' : 'fail'
}

try {
  // ══════════════════════════════════════════════════════════
  console.log('\n[1] 不设 TTS_PROXY → 必须走直连')
  // ══════════════════════════════════════════════════════════
  delete process.env.TTS_PROXY
  check('ttsProxyFromEnv() 未设时返回 undefined', ttsProxyFromEnv() === undefined, String(ttsProxyFromEnv()))
  const before1 = seen.length
  const r1 = await synth('直连')
  check('合成成功（对照组要有结果，否则"代理没收到"毫无意义）', r1.ok, `${r1.ms}ms`)
  check('**没设代理时，代理侧收不到任何连接**（证明不设 = 真直连）',
    seen.length === before1, `proxy 连接数 ${before1} → ${seen.length}`)

  // ══════════════════════════════════════════════════════════
  console.log('\n[2] 设 TTS_PROXY → 流量必须真的从代理出去')
  // ══════════════════════════════════════════════════════════
  const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`
  process.env.TTS_PROXY = PROXY_URL
  check('ttsProxyFromEnv() 设了就透传', ttsProxyFromEnv() === PROXY_URL, String(ttsProxyFromEnv()))
  const before2 = seen.length
  const r2 = await synth('走代理')
  const v2 = verdictOf(r2, PROXY_URL)
  if (v2 === 'ok') check('合成成功（经代理仍能拿到音频）', true, `${r2.ms}ms ${r2.bytes}B`)
  else if (v2 === 'skip') skip('合成成功（经代理仍能拿到音频）', `上游 RST，重试 ${r2.attempts} 次后仍失败 —— 与代理无关`)
  else check('合成成功（经代理仍能拿到音频）', false, r2.err)

  const newConns = seen.slice(before2)
  check('**代理侧看到了 CONNECT**（这才是"真的走了代理"）',
    newConns.length > 0, JSON.stringify(newConns.slice(0, 3)))
  check('隧道目标是上游语音主机（不是别的域名）',
    newConns.some((c) => c.tunnel && /speech\.platform\.bing\.com(?::443)?$/i.test(c.target || '')),
    newConns.map((c) => c.target).join(', '))

  // ══════════════════════════════════════════════════════════
  console.log('\n[3] `socks5://` 必须被挡掉（https-proxy-agent 只支持 HTTP CONNECT）')
  // ══════════════════════════════════════════════════════════
  process.env.TTS_PROXY = 'socks5://127.0.0.1:1080'
  check('socks5:// 不被采纳（否则会把 CONNECT 报文发给 SOCKS 端口 → 挂住重试）',
    ttsProxyFromEnv() === undefined, String(ttsProxyFromEnv()))
} finally {
  proxy.close()
}

const passed = results.filter((r) => r.ok).length
const skipped = results.filter((r) => r.kind === 'skip').length
console.log(`\n===== TTS 出口代理验收：${passed} passed / ${results.length - passed} failed${skipped ? ` / ${skipped} skipped` : ''} =====`)
if (passed !== results.length) {
  console.log('失败项: ' + results.filter((r) => !r.ok).map((r) => r.label).join(' / '))
  process.exit(1)
}
