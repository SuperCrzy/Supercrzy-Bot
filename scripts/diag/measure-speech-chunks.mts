/**
 * Speech chunking measurement — run a real long reply through the client's actual logic and report
 * "where the cut points land + whether playback starves".
 *
 * Why it exists: reading that sounds "choppy" is easiest to blame on "the char cap is too small",
 * but you cannot verify that by ear — the cut points have to be laid out: **what percentage of cuts
 * land mid-sentence** and **how many seconds are silent in total**.
 * After batching switched to "unplayed seconds", this runs a deterministic simulation of strategy C:
 *   · text arrives at the real SSE granularity (18 chars/frame), generation at 21 chars/s (median
 *     from the real DB)
 *   · playback at 4.8 chars/s; unplayed seconds = pushed chars / 4.8 − elapsed playback time
 * Those two ratios are the direct measure of "choppiness". Re-run this script to compare whenever
 * thresholds or cut rules change.
 *
 * Every decision function is imported from source (not copied by hand), so source changes flow
 * through automatically.
 *
 * Usage:
 *   ./node_modules/.bin/tsx --tsconfig packages/client/tsconfig.json \
 *     scripts/diag/measure-speech-chunks.mts [text files...]
 * With no arguments the built-in samples are used (one Chinese, one English).
 */
import { readFileSync } from 'node:fs'
import {
  finishLiveChunk,
  isSentenceTail,
  markdownToSpeech,
  packForTts,
  takeLiveChunk,
} from '../../packages/client/src/utils/speech-text'

const GEN_CPS = 21   // generation speed (chars/s, median of 11 real-DB samples)
const PLAY_CPS = 4.8 // playback speed (chars/s, measured)
const SSE_CHUNK = 18 // ≈ real SSE frame granularity

const SAMPLE_ZH = `核完了，两边都是本轮实测。先说三个必须先承认的自我修正，再谈差异。

**修正一：项目其实有内置朗读。** 后端有两个服务文件，前端也有两个 composable，都在。
上一轮我说"只能借系统 say"，是我漏看了目录结构。

**修正二：工具数是四十五，不是我说的四十三。** 这个数字来自运行时注册表，不是文档。

**修正三：落盘路径是统一的。** 所有会话写同一个数据库，没有按项目分库。`
const SAMPLE_EN = `I opened the site in the built-in browser and walked through its main sections — here's what's actually live right now.

**What the site is**
An independent AI news publication, not a feed aggregator. It self-describes as building around four things: content understanding, reading efficiency, mission alignment, and a future-facing experience.

**What changed**
The reading layer now runs on a single stream per message, which removes the per-sentence handshake that used to add seven to ten seconds of silence between blocks.`

interface Row {
  total: number
  midSentence: number
  forced: number
  starveSec: number
  minAhead: number
  firstSegChars: number
}

function analyze(name: string, raw: string): Row | null {
  const full = markdownToSpeech(raw)
  if (!full) return null
  let buf = ''
  let pushed = false
  let pushedChars = 0 // cleaned chars confirmed pushed to synthesis
  let elapsed = 0     // simulation clock (s)
  let starveSec = 0
  let minAhead = Infinity
  const outs: { sent: string; raw: string; midSentence: boolean; forced: boolean }[] = []
  const ahead = () => Math.max(0, pushedChars / PLAY_CPS - elapsed)

  const flushCut = (chunk: string) => {
    const rawEndedAtLine = chunk.endsWith('\n')
    const clean = markdownToSpeech(chunk)
    const sent = finishLiveChunk(clean, rawEndedAtLine)
    if (!sent) return
    pushed = true
    pushedChars += sent.length
    // Only two cut-quality problems exist: a hard mid-sentence cut (no punctuation, no line end)
    // and a forced sentence terminator
    const mid = !rawEndedAtLine && !isSentenceTail(clean)
    outs.push({ sent, raw: chunk, midSentence: mid, forced: sent !== clean })
  }

  for (let i = 0; i < raw.length; i += SSE_CHUNK) {
    buf += raw.slice(i, i + SSE_CHUNK)
    elapsed += SSE_CHUNK / GEN_CPS
    for (;;) {
      const cut = takeLiveChunk(buf, { first: !pushed, bufferedAheadSec: ahead() })
      if (!cut) break
      buf = cut.rest
      flushCut(cut.chunk)
    }
    // Settle starvation once per tick while playback is still catching up
    const a = pushedChars / PLAY_CPS - elapsed
    minAhead = Math.min(minAhead, a)
    if (a < 0 && pushed) starveSec += Math.min(-a, SSE_CHUNK / GEN_CPS)
  }
  // Generation finished: wrap up the remainder (the packForTts path used by flushLive)
  if (buf.trim()) {
    for (const pack of packForTts(markdownToSpeech(buf))) {
      pushedChars += pack.length
      const mid = !isSentenceTail(pack)
      outs.push({ sent: pack, raw: '[tail]', midSentence: mid, forced: false })
    }
    buf = ''
  }
  if (!outs.length) return null

  const total = outs.length
  // The first chunk is excluded from the "mid-sentence cut" metric: the first sentence may run
  // 100+ chars, so cutting it at the 60-char fallback (on a word boundary, no punctuation added)
  // is a **deliberate** trade-off — waiting for the sentence end delays first sound by 4~5s.
  const mid = outs.filter((o, i) => i > 0 && o.midSentence).length
  const forced = outs.filter((o) => o.forced).length
  const lens = outs.map((o) => o.sent.length)
  console.log(`\n=== ${name}  可朗读 ${full.length} 字（未播秒数策略） ===`)
  console.log(
    `${total} 段  平均 ${Math.round(lens.reduce((a, b) => a + b, 0) / total)} 字  ` +
      `最长 ${Math.max(...lens)}  最短 ${Math.min(...lens)}  首段 ${lens[0]} 字`,
  )
  console.log(
    `句中硬切: ${mid}/${total} = ${((mid / total) * 100).toFixed(0)}%   ` +
      `补句末标点: ${forced}/${total} = ${((forced / total) * 100).toFixed(0)}%   ` +
      `断粮累计 ${starveSec.toFixed(1)}s（最险余量 ${minAhead === Infinity ? '-' : minAhead.toFixed(1) + 's'}）`,
  )
  console.log('前 6 段（⏎ = 段界；段尾就是合成器听到的最后一个字）:')
  for (const o of outs.slice(0, 6)) {
    console.log(`  ${String(o.sent.length).padStart(3)}字 ${o.midSentence ? '句中' : '    '} …${o.raw.replace(/\n/g, '⏎').slice(-26)}`)
  }
  return { total, midSentence: mid, forced, starveSec, minAhead: minAhead === Infinity ? 0 : minAhead, firstSegChars: lens[0] }
}

const files = process.argv.slice(2)
const cases: { name: string; text: string }[] = files.length
  ? files.map((f) => ({ name: f.split('/').pop() || f, text: readFileSync(f, 'utf8') }))
  : [
      { name: '样本·中文', text: SAMPLE_ZH },
      { name: '样本·英文', text: SAMPLE_EN },
    ]

const rows: { name: string; r: Row }[] = []
for (const c of cases) {
  const r = analyze(c.name, c.text)
  if (r) rows.push({ name: c.name, r })
}

console.log('\n### 汇总（验收口径：段数 ≤ 12 / 句中硬切 0 / 断粮 ≤ 6s / 首段 ≤ 1 句）')
for (const { name, r } of rows) {
  const ok =
    r.total <= 12 && r.midSentence === 0 && r.starveSec <= 6 && r.firstSegChars <= 120
  console.log(
    `  ${name}: ${r.total} 段 / 句中 ${r.midSentence} / 断粮 ${r.starveSec.toFixed(1)}s / 首段 ${r.firstSegChars} 字 → ${ok ? 'PASS' : 'FAIL'}`,
  )
}
