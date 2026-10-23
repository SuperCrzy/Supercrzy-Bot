/**
 * Normalize the `web_search` tool output for the dedicated card.
 *
 * Why parse JSON instead of regexing the text: `web_search` already returns a **structured machine
 * contract** (`{ engine, query, results: [{ title, url, content|snippet, date }] }`), so the shapes
 * here are guaranteed by the tool, not guessed from prose. If the string is not that contract (error
 * message, provider drift), we return `null` and the caller falls back to the generic card — a
 * search card that silently shows nothing is worse than no card.
 *
 * Pure functions only: the card's rendering decisions are derived from this, so it can be asserted
 * in unit tests instead of eyeballed.
 */

export interface SearchHit {
  title: string
  url: string
  /** Bare hostname (no `www.`) — the trust signal a reader actually uses */
  domain: string
  snippet: string
  /** Provider date as-is (`2026-10-23`, ISO, or human "3 days ago"); undefined when unknown */
  date?: string
}

export interface SearchPayload {
  query: string
  engine?: string
  results: SearchHit[]
}

const MAX_SNIPPET = 220

function pickString(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim()
  return ''
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

function clip(s: string, max = MAX_SNIPPET): string {
  if (s.length <= max) return s
  return `${s.slice(0, max).trimEnd()}…`
}

/** Returns `null` when the text is not a search payload (caller falls back to the generic card). */
export function parseSearchPayload(raw: unknown): SearchPayload | null {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text || text[0] !== '{') return null
  let obj: any
  try {
    obj = JSON.parse(text)
  } catch {
    return null
  }
  if (!obj || !Array.isArray(obj.results)) return null

  const results: SearchHit[] = []
  for (const r of obj.results) {
    const url = pickString(r?.url, r?.link)
    const title = pickString(r?.title, r?.name)
    if (!url || !title) continue // a hit without title/url cannot be verified → drop it
    results.push({
      title,
      url,
      domain: domainOf(url),
      snippet: clip(pickString(r?.content, r?.snippet, r?.description)),
      date: pickString(r?.date, r?.publishedAt, r?.published_at) || undefined,
    })
  }

  return {
    query: pickString(obj.query),
    engine: pickString(obj.engine, obj.engines) || undefined,
    results,
  }
}
