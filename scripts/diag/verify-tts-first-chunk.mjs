/**
 * 探针⑤：Edge TTS **首块到达时间** vs **完整合成时长**（决定流式转发的收益上限）。
 *
 * 为什么关键：上游本来就是流式回块的，只是旧实现把它攒成了整包。若首块在数百 ms 就到、
 * 而完整合成要数秒 ⇒ 服务端改成"边收边转发"后，首声 ≈ 首块时间，而不是整段合成时间。
 *
 * 🔴 2026-10-12 重写：上游已从 v1（`speech.platform.bing.com/.../readaloud/edge/v1`）
 * 迁到 v2（`api.msedgeservices.com/tts/cognitiveservices/websocket/v1`）。本探针改为直接调用
 * **我们自己的服务层** `synthesizeSpeechStream` —— 于是它测的就是线上真实路径；
 * 旧版是自己拼一套协议帧（走 `node-edge-tts` 的 `_connectWebSocket()`），
 * 换 host 后立刻失效且**毫无提示**，正是这次迁移踩过的坑。
 *
 * 用法（需要 tsx —— 它 import 的是 .ts 源码）：
 *   pnpm -C packages/server exec tsx scripts/diag/verify-tts-first-chunk.mjs
 */
import { synthesizeSpeechStream } from '../../packages/server/src/services/tts.ts'

const PARA =
  '首块到达时间决定了流式转发方案的首声延迟，而完整合成时间决定了当前方案的首声延迟。两者之差就是流式转发能拿回来的收益。'
const SHORT = '这是一次短文本的首块到达测量。'
const LONG = PARA.repeat(30).slice(0, 1596)

async function measure(text, tag) {
  const t0 = Date.now()
  let first = 0
  let chunks = 0
  let bytes = 0
  try {
    await synthesizeSpeechStream(text, { voice: 'zh-CN-XiaoxiaoNeural', rate: 'default' }, (buf) => {
      if (!first) first = Date.now() - t0
      chunks += 1
      bytes += buf.length
    })
  } catch (e) {
    return { tag, len: text.length, err: String(e?.message || e) }
  }
  return { tag, len: text.length, first, full: Date.now() - t0, chunks, bytes }
}

for (const [text, tag] of [
  [SHORT, '短'],
  [LONG, '真实首包'],
  [LONG, '真实首包'],
  [LONG, '真实首包'],
]) {
  const r = await measure(text, tag)
  if (r.err) {
    console.log(`${tag}(${r.len}字) 失败: ${r.err}`)
    continue
  }
  console.log(
    `${tag.padEnd(6)} ${String(r.len).padStart(4)}字  首块 ${String(r.first).padStart(5)}ms  ` +
      `完整 ${String(r.full).padStart(5)}ms  块数 ${r.chunks}  共 ${r.bytes}B  ` +
      `⇒ 首块比完整早 ${r.full - r.first}ms`,
  )
}
