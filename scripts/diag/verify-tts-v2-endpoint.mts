/**
 * `/api/tts` 真实 HTTP 级验收（2026-10-12，v2 端点迁移后新增）。
 *
 * 为什么不用 `pnpm dev` 起整台后端：装机版 Electron 应用正占着 :3000（且它是旧代码），
 * 而 TTS 路由**只依赖 `services/tts`**（无 DB / 无 scheduler / 无 bot），
 * 所以把同一个 `ttsRouter` 挂到裸 Koa 上，就能在不动装机进程的前提下验完整的
 * 「路由 → 序列化 → 服务层 → 上游」链路。
 *
 * 跑法（须干净 env，见 SKILL `clean-shell-env`）：
 *   ./node_modules/.bin/tsx scripts/diag/verify-tts-v2-endpoint.mts
 *
 * 判据全部落在**字节与状态码**上，不接受"函数没抛错"。
 */
import Koa from 'koa'
import bodyParser from 'koa-bodyparser'
import { createServer } from 'http'
import { ttsRouter } from '../../packages/server/src/routes/tts'

const PORT = 8791
const BASE = `http://127.0.0.1:${PORT}`
const TEXT =
  '这是一次语音链路的端到端复测。请把这段话完整朗读出来，用来确认新的上游端点已经生效，' +
  '并且整包与流式两条路径都能稳定拿到可播放的音频数据。'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `   [${detail}]` : ''}`)
  ok ? pass++ : fail++
}
/** MP3 帧同步字：0xFF 后跟 0xE0 掩码为 0xE0 */
const looksLikeMp3 = (b: Buffer) => b.length > 1000 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0

const app = new Koa()
app.use(bodyParser())
app.use(ttsRouter.routes()).use(ttsRouter.allowedMethods())
const server = createServer(app.callback())
await new Promise<void>((r) => server.listen(PORT, r))

const post = (p: string, body: unknown) =>
  fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

console.log('[1] GET /api/tts/voices')
{
  const res = await fetch(BASE + '/api/tts/voices')
  const j: any = await res.json()
  check('200 且返回音色清单', res.status === 200 && Array.isArray(j.voices) && j.voices.length > 0,
    `${res.status} / ${j.voices?.length} 个音色 / default=${j.default} / maxChars=${j.maxChars}`)
}

console.log('\n[2] POST /api/tts（整包）')
{
  const t0 = Date.now()
  const res = await post('/api/tts', { text: TEXT, voice: 'zh-CN-XiaoxiaoNeural', rate: '+20%' })
  const buf = Buffer.from(await res.arrayBuffer())
  const ms = Date.now() - t0
  check('HTTP 200（不再是 502）', res.status === 200, `status=${res.status}`)
  check('Content-Type = audio/mpeg', (res.headers.get('content-type') || '').includes('audio/mpeg'),
    res.headers.get('content-type') || '(空)')
  check('Cache-Control = no-store', res.headers.get('cache-control') === 'no-store',
    res.headers.get('cache-control') || '(空)')
  check('拿到非空 mp3（帧同步字正确）', looksLikeMp3(buf),
    `${buf.length}B / ${ms}ms / 头 ${buf.subarray(0, 4).toString('hex')}`)
}

console.log('\n[3] 票据 + GET /api/tts/stream（流式 chunked）')
{
  const res1 = await post('/api/tts/ticket', { text: TEXT, voice: 'zh-CN-XiaoxiaoNeural', rate: '+20%' })
  const { token } = (await res1.json()) as any
  check('票据签发（48 位 hex）', res1.status === 200 && /^[0-9a-f]{48}$/.test(token || ''),
    `${res1.status} / token=${String(token).slice(0, 12)}…`)

  const t0 = Date.now()
  const res = await fetch(`${BASE}/api/tts/stream?t=${token}`)
  const ttfb = Date.now() - t0
  const reader = res.body!.getReader()
  const parts: Buffer[] = []
  let firstAt = 0
  let reads = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    reads++
    if (!firstAt) firstAt = Date.now() - t0
    parts.push(Buffer.from(value!))
  }
  const total = Buffer.concat(parts)
  const elapsed = Date.now() - t0

  check('HTTP 200', res.status === 200, `status=${res.status}`)
  check('Content-Type = audio/mpeg', (res.headers.get('content-type') || '').includes('audio/mpeg'),
    res.headers.get('content-type') || '(空)')
  check('X-Accel-Buffering = no（nginx 不缓冲）', res.headers.get('x-accel-buffering') === 'no',
    res.headers.get('x-accel-buffering') || '(空)')
  check('无 Content-Length ⇒ 真 chunked', res.headers.get('content-length') === null,
    `content-length=${res.headers.get('content-length') ?? 'null'}`)
  check('整体是合法 mp3', looksLikeMp3(total),
    `${total.length}B / ${reads} 次 read / 头 ${total.subarray(0, 4).toString('hex')}`)
  // 流式的全部价值就在"首块远早于整体完成后才到齐"；相等即退化成整包
  check('首字节远早于整体完成（流式语义成立）', firstAt > 0 && firstAt < elapsed - 50,
    `TTFB ${ttfb}ms / 首块 ${firstAt}ms / 总 ${elapsed}ms`)
}

console.log('\n[4] 负向断言（口径不能分叉）')
{
  const r1 = await post('/api/tts', { text: '   ' })
  check('空文本 → 400（不是 502）', r1.status === 400, `${r1.status} / ${(await r1.json()).error}`)

  const r2 = await fetch(BASE + '/api/tts/stream?t=' + 'z'.repeat(48))
  check('非法票据 → 410（不是 404）', r2.status === 410, `${r2.status} / ${(await r2.json()).error}`)

  const r3 = await post('/api/tts/ticket', { text: 'x'.repeat(99999) })
  check('超长文本 → 400', r3.status === 400, `${r3.status} / ${(await r3.json()).error}`)
}

console.log(`\n===== /api/tts HTTP 验收：${pass} passed / ${fail} failed =====`)
server.close()
process.exit(fail ? 1 : 0)
