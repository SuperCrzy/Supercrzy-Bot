/**
 * 朗读文本清洗（TTS）：把 AI 回复正文（markdown）转成"适合听"的纯文本。
 *
 * 原则（2026-09-26 老板拍板）：只读结论性内容。
 *   ✅ 标题 / 段落 / 列表 / 引用（去符号）
 *   ❌ 代码块 / 表格 / 图 / 图片 / URL / HTML 标签 / 分隔线 / **emoji 与装饰符号**（2026-09-28 加）
 *   🔁 链接只读文字；行内 code 去反引号保留内容（短标识符念出来有意义）
 *
 * 纯函数，便于单测；不含任何浏览器 API。
 */

const CODE_FENCE_RE = /```[\s\S]*?```/g
const SVG_BARE_RE = /<svg[\s\S]*?<\/svg>/gi
/** fenced code 之外的裸 HTML/XML 标签（含 <table> 等） */
const HTML_TAG_RE = /<\/?[a-zA-Z][^>\n]*>/g
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g
/** 裸 URL（没有 markdown 链接包着的）—— 念出来是一串字母斜杠，纯噪音 */
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()（）【】\]]+/g

/**
 * emoji 及其"组成部分"（2026-09-28 老板要求：emoji 不要朗读）。
 *
 * 为什么不只删 `\p{Extended_Pictographic}`：一个 emoji 是**多码点序列**，
 * 只删主字符会剩下变体选择符/肤色修饰符/零宽连接符/区域指示符，
 * 它们照样会被念成"零宽连接符"或让合成器卡一下。所以组成部分一并删。
 */
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0e\ufe0f\u20e3]/gu
/**
 * 装饰性符号：不是 emoji，但念出来同样是噪音（还有的会被读成"右箭头""黑色圆圈"）。
 * 特意**不带** `\u00a0-\u00ff` 段：那里有 `°` `±` `×` 这类真有用处的符号（"25°C"）。
 */
const DECOR_SYMBOL_RE = /[\u2190-\u21ff\u2300-\u23ff\u2500-\u257f\u25a0-\u25ff\u2700-\u27bf\u2b00-\u2bff]/g
/** 表格行：含 | 且形如 | a | b |，或表头分隔行 |---|---| */
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/
const HR_RE = /^\s*(?:[-*_]\s*){3,}$/
/** 行首列表/引用符号 */
const LIST_PREFIX_RE = /^\s*(?:[-*+]|\d+[.)])\s+/
const QUOTE_PREFIX_RE = /^\s*>\s?/
const HEADING_PREFIX_RE = /^\s{0,3}#{1,6}\s+/
/** markdown 强调标记 */
const EMPHASIS_RES: Array<[RegExp, string]> = [
  [/\*\*([^*]+)\*\*/g, '$1'],
  [/\*([^*]+)\*/g, '$1'],
  [/__([^_]+)__/g, '$1'],
  [/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2'],
  [/~~([^~]+)~~/g, '$1'],
]
const INLINE_CODE_RE = /`([^`]+)`/g
/**
 * 残留标记（2026-10-22 老板实测：朗读把"星号""符号"念出来了）。
 *
 * 为什么成对替换不够：流式朗读按块送合成（`takeStreamChunk` 优先切在行边界/句末），
 * `**加粗**` 很容易被切成 `**加粗` + `**`，两边**都配不上对** ⇒ 上面那组 EMPHASIS_RES
 * 全部落空 ⇒ 星号原样进合成器。同理被切断的 `` ` ``、`~~`、`__` 也会漏。
 * 这些字符在口语里没有任何信息量，所以按"清了不会错"的原则兜底剔除：
 *   · `*`、反引号、`|`：整类清掉（正文里没有"必须念出来"的用法；`|` 只剩被切断的半截表格行）
 *   · `~` `_`：只清连续 2 个及以上（`__x__`/`~~x~~` 的残骸），保住 `user_id`、`~5` 这类正常写法
 */
const RESIDUAL_MARKERS_RE = /[*`|]+|~{2,}|_{2,}/g

export function markdownToSpeech(md: string): string {
  if (!md) return ''
  let s = String(md)

  // ① 整体剔除：代码块、SVG、图片、emoji、装饰符号（这些内容念出来是噪音）
  s = s.replace(SVG_BARE_RE, '')
  s = s.replace(CODE_FENCE_RE, '')
  s = s.replace(IMAGE_RE, '')
  s = s.replace(EMOJI_RE, '')
  s = s.replace(DECOR_SYMBOL_RE, '')

  // ② 链接只留文字、裸 URL 整条删；裸 HTML 标签剔除
  s = s.replace(LINK_RE, '$1')
  s = s.replace(BARE_URL_RE, '')
  s = s.replace(HTML_TAG_RE, '')

  // ③ 逐行处理：跳表格/分隔线，去标题/列表/引用/强调符号
  const out: string[] = []
  for (const rawLine of s.split('\n')) {
    const line = rawLine
    if (TABLE_ROW_RE.test(line)) continue
    if (HR_RE.test(line)) continue
    let t = line
    t = t.replace(HEADING_PREFIX_RE, '')
    t = t.replace(QUOTE_PREFIX_RE, '')
    t = t.replace(LIST_PREFIX_RE, '')
    t = t.replace(INLINE_CODE_RE, '$1')
    for (const [re, rep] of EMPHASIS_RES) t = t.replace(re, rep)
    // 兜底：成对替换后仍残留的标记（跨块切断的 ** / ` 等）一律剔除，别让合成器去念符号
    t = t.replace(RESIDUAL_MARKERS_RE, '')
    out.push(t)
  }
  s = out.join('\n')

  // ④ 压缩空行与行内空白
  s = s
    .split('\n')
    .map((l) => l.replace(/[ \t\u3000]{2,}/g, ' ').trimEnd())
    .join('\n')

  // ⑤ 剔除纯符号残留行（如 --- / *** / ===），但保留空行（段落断句对朗读有意义）
  s = s
    .split('\n')
    .filter((l) => l.trim() === '' || /[\p{L}\p{N}]/u.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return s
}

/**
 * 从消息 content 取可朗读文本（兼容 string / 结构化数组两种形态）。
 * 数组形态只取 type==='text' 的块，与前端正文渲染口径一致。
 */
export function extractSpeakText(content: unknown): string {
  if (!content) return ''
  if (Array.isArray(content)) {
    const joined = content
      .map((b: any) => (b && b.type === 'text' ? String(b.text || '') : ''))
      .join('\n')
    return markdownToSpeech(joined)
  }
  return markdownToSpeech(String(content))
}

/** 句末标点（切分点，保留标点在句尾）；`；;` 也算 —— 列举项各自成句反而更清楚 */
const SENTENCE_END_RE = /(?<=[。！？!?；;…])/
/** 一段文本自身是否以句末标点收尾（**唯一来源**：ensureSentenceEnd 与流式切点共用） */
const SENTENCE_TAIL_RE = /[。！？!?…；;]$/
/** 软停顿（逗号/顿号/冒号分号/空白）：硬切时优先在这里断，别把句子从中间劈开 */
const SOFT_BREAK_RE = /[，、,；;：:\s]/

/**
 * 一包（= 一次合成请求）最多放多少字。与后端 `services/tts.ts` 的 `TTS_MAX_CHARS` 对齐。
 *
 * 为什么敢放这么大 —— 2026-09-28 受控实测（绕开服务层与重试，直接调 EdgeTTS，单次尝试 60s 超时）：
 *
 *   | 文本 | 耗时 | 产出音频 | 实时率 |
 *   |---|---|---|---|
 *   | 40 字 | 1.2s | 9.0s | 7.3x |
 *   | 200 字 | 1.6s | 43.9s | 27.6x |
 *   | 500 字 | 1.8s | 109.3s | 61.9x |
 *   | 1900 字 | 4.3s | 414s | 96x |
 *
 * ⇒ **合成耗时几乎只由握手决定，基本不随长度变**。这条数据推翻了"必须按句切"这个前提：
 *    按句切成 N 次请求 = 把 1 次的固定成本付了 N 次，还白送 N−1 个断档点。
 */
export const TTS_PACK_MAX_CHARS = 2000

/**
 * 打包（Pro 档 TTS 用）：把可朗读文本切成尽量少的几包，**一包 = 一次合成请求**。
 *
 * 两条不变量：
 *   ① **不丢字、不加字** —— `packs.join('')` 恒等于原文（剔除段落分隔符、补齐句末标点后）的字符序列；
 *      硬切路径尤其要守住（`join('')` 与原文本逐字相等，单测覆盖）。
 *   ② **每包末尾必带句末标点** —— 段尾没有标点时合成器会用"话没说完"的语调收尾。
 *
 * 🔴 **段落不是硬边界**（2026-09-28 纠正）：早先的实现按段落强制断开，导致一条 3 段的回复
 * 必然发 3 次合成请求，每段之间各等一次合成（实测单次 2.2~3.5s，抖动时 7~15s）
 * ⇒ 听感就是"**读完一段停几秒**"。现在段落只当软停顿，一路合并到 maxLen 为止。
 */
export function packForTts(text: string, maxLen = TTS_PACK_MAX_CHARS): string[] {
  const out: string[] = []
  if (!text) return out

  // ① 段落 → 句子流（段落分隔不再保留为边界），逐句补齐句末标点
  const sentences: string[] = []
  for (const para of String(text).split(/\n+/)) {
    const p = para.trim()
    if (!p) continue
    for (const raw of p.split(SENTENCE_END_RE)) {
      // 保留句间原有空格：英文句子合并后不能粘成一坨
      const lead = /^[ \t]/.test(raw) ? ' ' : ''
      const s = ensureSentenceEnd(raw)
      if (s) sentences.push(lead + s)
    }
  }

  // ② 贪心打包：能塞就塞，塞不下才开新包
  let buf = ''
  for (const s of sentences) {
    if (s.length > maxLen) {
      // 单句就超上限（无句末标点的超长文本）→ 落掉手里的，再把这句硬切
      if (buf) { out.push(buf); buf = '' }
      const hard = hardSplit(s, maxLen)
      out.push(...hard.slice(0, -1))
      buf = hard[hard.length - 1] || ''
      continue
    }
    if (buf && buf.length + s.length > maxLen) { out.push(buf); buf = s }
    else buf += s
  }
  if (buf) out.push(buf)
  return out
}

/**
 * 把没有句末标点的超长文本硬切到 maxLen 以内，**不丢字**（`hardSplit(s).join('') === s`）。
 * 优先落在软停顿后（词与词之间），找不到才真硬劈。
 *
 * 病理路径：正常回复不会走到这里（句子都被句末标点切开，且包上限 2000 字）。
 * 硬切出来的中间片**不补句末标点** —— 优先守住"不丢字/不加字"，代价是这一包收尾语调略生硬。
 */
function hardSplit(s: string, maxLen: number): string[] {
  const out: string[] = []
  let buf = s
  while (buf.length > maxLen) {
    const at = softCutIndex(buf, maxLen)
    out.push(buf.slice(0, at))
    buf = buf.slice(at)
  }
  if (buf) out.push(buf)
  return out
}

/**
 * 在 `s` 的前 maxLen 个字符里挑一个"别把句子劈开"的切点。
 * 从后往前找软停顿，但不退得太前（至少保留 60% 长度），否则会切出一堆碎段。
 * 找不到就老老实实硬切。
 */
function softCutIndex(s: string, maxLen: number): number {
  const floor = Math.floor(maxLen * 0.6)
  for (let i = maxLen - 1; i >= floor; i--) {
    if (SOFT_BREAK_RE.test(s[i])) return i + 1
  }
  return maxLen
}

/**
 * 补齐句末标点 —— **只影响送给 TTS 的文本**，不改用户看到的正文。
 *
 * 为什么需要：每包是独立的合成请求，包尾没有句末标点时合成器会用"话没说完"的语调收尾，
 * 下一包又从零起调 → 听感一顿一顿。补一个句号让每包都能自然落地：
 *   · 已以句末标点结尾 → 原样返回
 *   · 以软停顿（，、：,）结尾 → **换成**句号（避免出现"，。"这种叠标点）
 *   · 其它（句中被硬切出来的）→ 补句号
 */
export function ensureSentenceEnd(s: string): string {
  const t = String(s || '').trim()
  if (!t) return ''
  if (SENTENCE_TAIL_RE.test(t)) return t
  if (/[，、：,:]$/.test(t)) return t.slice(0, -1) + '。'
  return t + '。'
}

// ===== 流式朗读攒批（2026-09-28「边生成边朗读」）=====

/**
 * 首块最小字数：不足就先攒着再判定。
 *
 * ⚠️ **只用于首块**。首块的唯一目标是"尽快出声"，所以门槛压到 **60 字**
 * （2026-10-21 由 200 降下来：200 字意味着"第一段已经显示出来了但不开口"，
 * 用户会觉得根本没在做边生成边读）。60 字 ≈ 一句话，正好对应"第一段落地就出声"。
 * 后续块的门槛抬到 `STREAM_MAX_CHARS`（见 useChatSpeech.drainStream 的两级门槛）——
 * 若后续块也按几十字切，一条 900 字回复会切成十几次请求，等于又回到
 * "把固定成本付 N 次"的老路（手机端每次固定成本 7~10s）。
 *
 * 另一个作用：让 `isWindowForeground()` 的调用频率从"每 chunk 一次"降到"够一块一次"。
 */
export const STREAM_FIRST_MIN_CHARS = 60

/**
 * 单块上限。攒到这里必须切，否则"第一声"的延迟没有上界。
 *
 * 取 600 的依据（实测表见上方 `TTS_PACK_MAX_CHARS`）：600 字 ≈ 1.6s 合成 → ≈130s 音频，
 * **实时率 80x** ⇒ 播放速度永远追得上文本生成速度，块间不缺料。
 * 而 1.6s 的合成成本相对 130s 的音频可以忽略 ⇒ 块间断档被压在 ~0。
 *
 * 为什么不是 packForTts 的 2000 —— 流式下文本还没生成完，块太大会让首声无限晚；
 * 600 是"首声 ≈ 2s"与"请求次数尽量少"之间的折中。
 */
export const STREAM_MAX_CHARS = 600

/**
 * 流式缓冲硬上限：开读条件一直不成立（比如一直在前台、档位是 background）时，
 * 超过它就本轮放弃流式，交给「完成后整条读」—— 避免为了一条长回复无限攒字符串。
 */
export const STREAM_BUFFER_HARD_MAX = 8000

export interface StreamChunkCut {
  /** 可立即送合成的块（**不含**由调用方后补的句末标点） */
  chunk: string
  /** 尚未成块、继续攒的剩余 */
  rest: string
}

/**
 * 从流式缓冲里切出"可以立刻送合成的一块"。返回 `null` = 继续攒。
 *
 * 三条不变量（都有单测）：
 *   ① **不丢字**：`cut.chunk + cut.rest === buf`（严格逐字相等）
 *   ② **不切在未闭合的代码围栏里** —— 切进去之后清洗逻辑认不出围栏，代码会被念出来
 *   ③ **切点优先落在行边界** —— markdown 的表格/列表/引用都是**行级**结构；
 *      切在行中间会让 `|---|` 这类残留被当成正文念
 *
 * 切点优先级：行边界 → 句末标点（无换行的长段落）→ 软停顿（已达上限时才硬切）。
 */
export function takeStreamChunk(
  buf: string,
  firstMin = STREAM_FIRST_MIN_CHARS,
  max = STREAM_MAX_CHARS,
): StreamChunkCut | null {
  const s = String(buf ?? '')
  if (!s) return null
  const at = pickStreamCut(s, firstMin, max)
  if (at <= 0 || at > s.length) return null
  if (!fenceBalanced(s.slice(0, at))) return null
  return { chunk: s.slice(0, at), rest: s.slice(at) }
}

function pickStreamCut(s: string, min: number, max: number): number {
  const over = s.length >= max
  const hi = over ? max : s.length
  // ① 行边界优先。已超上限时下界抬到 60% —— 否则一个靠前的换行会把块切得过碎
  const lo = over ? Math.floor(max * 0.6) : min
  for (let i = hi - 1; i >= lo; i--) {
    if (s[i] === '\n') return i + 1
  }
  // ② 句末标点：别把句子从中间劈开
  const se = lastSentenceEnd(s, lo, hi)
  if (se > 0) return se
  // ③ 已达上限且既没换行也没句末标点 → 退而求其次切软停顿（真没有就硬切）
  return over ? softCutIndex(s, max) : 0
}

/**
 * `[min, max]` 区间内最后一个句末标点的下标 + 1；没有则 0。
 *
 * 🔴 两个反直觉点，都踩过：
 *   · lookbehind 分割后**最后一段也可能是完整句**（`'a。'.split(/(?<=。)/)` → `['a。']`），
 *     所以不能像早先那样只扫到 `parts.length - 1` —— 那会让"整段都是完整句子"的输入
 *     永远切不出块（表现为"攒够字数了却一直不出声"）。
 *   · 必须**带上 max 上界**：否则一旦区间外的句子更靠后，会切出超过单块上限的块。
 */
function lastSentenceEnd(s: string, min: number, max: number): number {
  const parts = s.split(SENTENCE_END_RE)
  let at = 0
  let best = 0
  for (const part of parts) {
    at += part.length
    if (at > max) break
    if (at >= min && SENTENCE_TAIL_RE.test(part)) best = at
  }
  return best
}

/** 代码围栏是否闭合（``` 出现次数为偶数） */
function fenceBalanced(s: string): boolean {
  let n = 0
  let i = s.indexOf('```')
  while (i !== -1) {
    n += 1
    i = s.indexOf('```', i + 3)
  }
  return n % 2 === 0
}
