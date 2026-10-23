/**
 * Tool retrieval index (A / G1 minimal version).
 *
 * Why not `name.includes(query)`: tool names are English, tool descriptions are Chinese, so any
 * Chinese query scored exactly zero and the model was handed a 34-line catalogue dump instead of
 * an answer. Verified against the reference implementation (WorkBuddy): they run a MiniSearch BM25
 * index over the *whole* tool text with prefix matching, a default topK of 10, and a server filter.
 * This file is the same idea without a dependency: a compact BM25 over name + description.
 *
 * Ranking choices:
 *   - `name` is weighted 3x: an exact/short name query ("terminal") should beat a description hit.
 *   - Chinese has no whitespace tokens, so CJK runs are indexed as **bigrams** (后台任务 →
 *     后台/台任/任务). One-character tokens are indexed only when the run itself is one char —
 *     single chars are noise for retrieval.
 *   - A literal substring hit on the name is worth a flat bonus: that covers prefixes
 *     ("term" → terminal_open) without a real prefix index.
 *
 * Pure functions only (no I/O, no globals besides a cache) so the ranking can be asserted in unit
 * tests instead of "looks right".
 */

export interface ToolDoc {
  name: string
  description?: string
}

export interface SearchHit {
  name: string
  score: number
  /** Terms that actually matched — surfaced for debugging, never shown to the model as-is */
  matched: string[]
}

/**
 * Alias terms for tools whose Chinese name-ish words users actually type are missing from their
 * description (e.g. nobody types "video_edit", they type "视频剪辑"). Indexed with weight 2.
 * Keep this list short: it is a stopgap for description wording, not a second catalogue.
 */
export const TOOL_ALIASES: Record<string, string[]> = {
  bg_task: ['后台任务', '后台进程', '任务进度'],
  generate_image: ['生成图片', '画一张图', '文生图'],
  draw_diagram: ['画图', '架构图', '流程图', '示意图'],
  video_edit: ['视频剪辑', '剪辑', '视频', '音频'],
  make_article: ['写文章', '长文'],
  terminal_open: ['终端', '命令行'],
  computer_use: ['桌面控制', '操作电脑'],
}

const K1 = 1.2
const B = 0.75
const NAME_WEIGHT = 3
/** Flat bonus for a literal substring hit on the tool name (covers prefix queries) */
const NAME_SUBSTRING_BONUS = 5
const EXACT_NAME_BONUS = 20

/** English words are split on non-alphanumerics; CJK runs become bigrams. Underscores stay. */
export function tokenize(text: string): string[] {
  const t = String(text || '').toLowerCase()
  const out: string[] = []
  for (const m of t.matchAll(/[a-z0-9_]+/g)) out.push(m[0])
  for (const seg of t.match(/[\u4e00-\u9fff]+/g) || []) {
    if (seg.length === 1) out.push(seg)
    for (let i = 0; i + 1 < seg.length; i++) out.push(seg.slice(i, i + 2))
  }
  return out
}

interface Doc {
  name: string
  lowerName: string
  /** term -> weighted frequency (name hits already multiplied by NAME_WEIGHT) */
  tf: Map<string, number>
  length: number
}

export interface ToolIndex {
  docs: Doc[]
  df: Map<string, number>
  avgLength: number
}

export function buildIndex(entries: ToolDoc[]): ToolIndex {
  const df = new Map<string, number>()
  const docs: Doc[] = []

  for (const e of entries) {
    const name = String(e.name || '')
    const tf = new Map<string, number>()
    let length = 0
    const bump = (term: string, w: number) => {
      tf.set(term, (tf.get(term) || 0) + w)
      length += w
    }
    for (const tok of tokenize(name)) bump(tok, NAME_WEIGHT)
    for (const tok of tokenize(e.description || '')) bump(tok, 1)
    for (const alias of TOOL_ALIASES[name] || []) for (const tok of tokenize(alias)) bump(tok, 2)
    for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1)
    docs.push({ name, lowerName: name.toLowerCase(), tf, length })
  }

  const total = docs.reduce((s, d) => s + d.length, 0)
  return { docs, df, avgLength: docs.length ? total / docs.length : 0 }
}

/**
 * BM25 search.
 *
 * Invariants kept by this function (asserted in tests):
 *   - `hits.length <= topK`
 *   - zero-score documents are never returned (an unmatched query yields `[]`, NOT the catalogue)
 *   - results are sorted by score, descending
 */
export function searchIndex(index: ToolIndex, query: string, topK = 8): SearchHit[] {
  const raw = String(query || '').trim().toLowerCase()
  const terms = [...new Set(tokenize(raw))]
  const n = index.docs.length
  if (!n || !terms.length) return []

  const scored: SearchHit[] = []
  for (const doc of index.docs) {
    let score = 0
    const matched: string[] = []
    for (const term of terms) {
      const tf = doc.tf.get(term) || 0
      if (tf <= 0) continue
      const df = index.df.get(term) || 0
      // BM25 idf, floored at 0 so a term present in every doc cannot go negative
      const idf = Math.max(0, Math.log(1 + (n - df + 0.5) / (df + 0.5)))
      const norm = 1 - B + (B * doc.length) / (index.avgLength || 1)
      score += idf * ((tf * (K1 + 1)) / (tf + K1 * norm))
      matched.push(term)
    }
    if (raw && doc.lowerName === raw) score += EXACT_NAME_BONUS
    else if (raw && doc.lowerName.includes(raw)) score += NAME_SUBSTRING_BONUS
    if (score > 0) scored.push({ name: doc.name, score, matched })
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  // 相对截断：低于最高分 30% 的命中是同义噪声（实测「后台任务」会带出 terminal_* / read_me 等）
  const best = scored[0]?.score || 0
  const kept = best > 0 ? scored.filter((h) => h.score >= best * 0.3) : scored
  return kept.slice(0, Math.max(1, Math.min(50, topK)))
}

/** Catalogue signature — rebuild only when the tool set actually changed. */
export function signatureOf(entries: ToolDoc[]): string {
  return entries.map((e) => `${e.name}\u0000${e.description || ''}`).join('\u0001')
}

let cache: { signature: string; index: ToolIndex } | null = null

/** Lazily built, auto-invalidating index over the live tool catalogue. */
export function getToolIndex(entries: ToolDoc[]): ToolIndex {
  const sig = signatureOf(entries)
  if (cache && cache.signature === sig) return cache.index
  cache = { signature: sig, index: buildIndex(entries) }
  return cache.index
}

/** Test hook. */
export function __resetToolIndexForTest(): void {
  cache = null
}
