/**
 * 探针④：浏览器对 **chunked mp3** 能不能边收边播？（决定方案 D 是否成立）
 *
 * 背景：现在 `/api/tts` 是 `res.blob()` 全量接收 —— 必须等**整个 mp3 合成完**才出声，
 * 而 Edge TTS 上游本身是 wss 流式回块的（见 node-edge-tts/dist/edge-tts.js:100-106）。
 * 若 `<audio src="...">` 对 chunked 响应真能边收边播，首声可提前到"首块到达"。
 *
 * 做法：本地起一个 http server，把同一段真实 mp3 分 10 块、每块间隔 400ms 吐出
 * （= 模拟上游流式到达）；再用 headless Chrome 加载 `<audio>`，记录
 * 「服务端开始写」→「音频真的开始推进 currentTime」→「服务端写完」三个时刻。
 *
 * 判据（不变量式）：若 首播时刻 ≪ 写完时刻 ⇒ 边收边播成立；若 首播时刻 ≈ 写完时刻 ⇒ 不成立。
 * 对照组：同样内容一次性写完（fast），用于给出"无延迟时的首播基线"。
 */
import { createRequire } from 'node:module'
import http from 'node:http'
const require = createRequire(import.meta.url)
const { chromium } = require('/Users/chaojiphonekuang/Downloads/supercrzy/supercrzy-agent/packages/server/node_modules/playwright-core')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 3999
const CHUNKS = 10
const CHUNK_DELAY_MS = 400

// ---- 拿一段真实 mp3（走我们自己的 /api/tts，保证格式与线上一致）----
const text = ('这是一段用于验证音频流式播放的测试文本，需要足够长以便切成多块逐步下发。').repeat(20)
const r = await fetch('http://localhost:3000/api/tts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text }),
})
if (!r.ok) { console.log('拿 mp3 失败:', r.status, await r.text()); process.exit(1) }
const mp3 = Buffer.from(await r.arrayBuffer())
const size = Math.floor(mp3.length / CHUNKS)
console.log(`真实 mp3: ${text.length} 字 → ${mp3.length} 字节，切成 ${CHUNKS} 块 × ${size} 字节\n`)

const marks = {}
let mode = 'slow'
let currentRun = 0

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`)
  if (u.pathname === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset="utf-8"><body>
      <audio id="a" preload="auto"></audio>
      <script>
        window.__m = { t0: 0, loadedMeta: 0, playing: 0, firstProgress: 0, stalled: 0, ended: 0, poll: [] }
        const a = document.getElementById('a')
        window.__start = (src) => {
          window.__m = { t0: performance.now(), loadedMeta: 0, playing: 0, firstProgress: 0, stalled: 0, ended: 0, poll: [] }
          a.src = src
          a.onloadedmetadata = () => { window.__m.loadedMeta = performance.now() }
          a.onplaying = () => { window.__m.playing = window.__m.playing || performance.now() }
          a.onstalled = () => { window.__m.stalled++ }
          a.onended = () => { window.__m.ended = performance.now() }
          const iv = setInterval(() => {
            window.__m.poll.push([Math.round(performance.now() - window.__m.t0), Number(a.currentTime.toFixed(2))])
            if (!window.__m.firstProgress && a.currentTime > 0.2) window.__m.firstProgress = performance.now()
            if (window.__m.ended) clearInterval(iv)
          }, 100)
          a.play().catch(e => { window.__m.playErr = String(e.name) })
        }
      </script></body>`)
    return
  }
  if (u.pathname === '/stream') {
    const run = Number(u.searchParams.get('run') || 0)
    if (run !== currentRun) { res.writeHead(409); res.end(); return }
    // 关键：**不设 Content-Length** ⇒ chunked
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' })
    const t0 = Date.now()
    marks[run] = { startWrite: t0, finishWrite: 0 }
    if (mode === 'fast') {
      res.write(mp3)
      res.end()
      marks[run].finishWrite = Date.now()
      return
    }
    let i = 0
    const tick = () => {
      if (i < CHUNKS) {
        res.write(mp3.subarray(i * size, i === CHUNKS - 1 ? mp3.length : (i + 1) * size))
        i++
        setTimeout(tick, CHUNK_DELAY_MS)
      } else {
        res.end()
        marks[run].finishWrite = Date.now()
      }
    }
    tick()
    return
  }
  res.writeHead(404); res.end()
})
await new Promise((res) => server.listen(PORT, res))

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage()
await page.goto(`http://localhost:${PORT}/page`, { waitUntil: 'domcontentloaded' })

async function run(m, runId) {
  mode = m
  currentRun = runId
  await page.evaluate(({ runId }) => window.__start(`/stream?run=${runId}`), { runId })
  await page.waitForFunction(() => window.__m.ended || window.__m.poll.length > 90, { timeout: 30000 }).catch(() => {})
  const d = await page.evaluate(() => window.__m)
  const mk = marks[runId]
  const totalWrite = mk.finishWrite - mk.startWrite
  const p = (x) => (x ? `${Math.round(x - d.t0)}ms` : '—')
  // 服务端与页面在同一台机器 ⇒ 同一个墙钟，可直接对齐
  const pageT0Wall = mk.startWrite // 近似：页面 t0 与 server startWrite 的差由下面校准
  console.log(`--- ${m}（服务端写完用了 ${totalWrite}ms）---`)
  console.log(`  页面时钟: loadedmetadata ${p(d.loadedMeta)}  playing ${p(d.playing)}  **开始推进 currentTime ${p(d.firstProgress)}**  ended ${p(d.ended)}`)
  console.log(`  stalled ${d.stalled} 次  playErr=${d.playErr || '无'}`)
  console.log(`  currentTime 轨迹: ${d.poll.filter((_, i) => i % 4 === 0).map(([t, c]) => `${t}:${c}`).slice(0, 14).join('  ')}`)
  console.log(`  ⇒ 首播发生在${d.firstProgress && d.firstProgress - d.t0 < totalWrite * 0.6 ? '【服务端还没写完】边收边播成立' : '【服务端写完之后】未边收边播'}`)
  console.log('')
  return { totalWrite, firstProgress: d.firstProgress ? d.firstProgress - d.t0 : null, playing: d.playing ? d.playing - d.t0 : null }
}

const slow = await run('slow', 1)
const fast = await run('fast', 2)

console.log('=== 结论 ===')
console.log(`慢速分块（跑到写完要 ${slow.totalWrite}ms）：首声 ${slow.playing}ms`)
console.log(`一次性下发（写完 ~0ms）：首声 ${fast.playing}ms`)
if (slow.playing != null && slow.playing < slow.totalWrite * 0.6) {
  console.log('⇒ <audio> 对 chunked mp3 **确实边收边播** ⇒ 方案 D（服务端流式转发）成立，首声可压到 ~1s')
} else {
  console.log('⇒ <audio> 对 chunked mp3 **不边收边播** ⇒ 方案 D 需要换路子（MSE / 分片独立请求）')
}

await browser.close()
server.close()
process.exit(0)
