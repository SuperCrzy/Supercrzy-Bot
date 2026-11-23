/**
 * Date parsing for search results, and the time filter that depends on it.
 *
 * The failure this covers: a query with timeRange=day returned nothing while the
 * same query without one returned five rows. The dates were present but written in
 * a localized form ("周一, 23 11月 2026 05:46:00 GMT") that Date.parse returns NaN
 * for, and the filter treats an unparseable date as out of range — so every result
 * was dropped. Worth pinning: the bug looked like "search is broken" and was
 * actually "one date format is unreadable".
 */
import { describe, it, expect } from 'vitest'
import { parseResultDate, postProcessSearchResults } from './search-providers'

describe('parseResultDate', () => {
  it('parses the localized Chinese format Bing returns', () => {
    const t = parseResultDate('周一, 23 11月 2026 05:46:00 GMT')
    expect(Number.isNaN(t)).toBe(false)
    expect(new Date(t).toISOString().startsWith('2026-11-23')).toBe(true)
  })

  it('parses RFC 1123 the same way', () => {
    // Both forms describe the same instant; they must not disagree.
    expect(parseResultDate('Mon, 23 Nov 2026 05:46:00 GMT'))
      .toBe(parseResultDate('周一, 23 11月 2026 05:46:00 GMT'))
  })

  it('parses a bare Chinese date', () => {
    expect(Number.isNaN(parseResultDate('2026年11月23日'))).toBe(false)
  })

  it('parses ISO dates', () => {
    expect(Number.isNaN(parseResultDate('2026-11-23'))).toBe(false)
  })

  it('returns NaN for junk rather than inventing a date', () => {
    // A made-up date would keep a stale result in a freshness-filtered search.
    expect(Number.isNaN(parseResultDate('recently'))).toBe(true)
    expect(Number.isNaN(parseResultDate(''))).toBe(true)
    expect(Number.isNaN(parseResultDate(undefined))).toBe(true)
  })
})

describe('postProcessSearchResults with maxAgeDays', () => {
  const today = new Date()
  const iso = (daysAgo: number) => new Date(today.getTime() - daysAgo * 86400000).toISOString()

  it('keeps results inside the window and drops older ones', () => {
    const rows = [
      { title: 'fresh', url: 'https://a.com/1', date: iso(0) },
      { title: 'stale', url: 'https://b.com/2', date: iso(30) },
    ]
    const out = postProcessSearchResults(rows, 10, 1)
    expect(out.map((r) => r.title)).toEqual(['fresh'])
  })

  it('no longer empties the list when dates are localized', () => {
    // The regression: a Chinese-locale date parsed to NaN, the filter read that as
    // out of range, and every result was dropped. Build the localized string for
    // *today* so the assertion is about parsing, not about which day it is.
    const d = new Date()
    const months = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月']
    const localized = `周${'日一二三四五六'[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:00 GMT`
    const rows = [{ title: 'today', url: 'https://a.com/1', date: localized }]
    // Before the fix this returned 0 because nothing survived the filter.
    expect(postProcessSearchResults(rows, 10, 1).length).toBe(1)
  })

  it('keeps undated results under a freshness filter, sorted last', () => {
    // Reversed deliberately. Dropping undated rows meant a query whose engines omit
    // dates came back empty — "no news today" when the news simply had no timestamp.
    // Expired results are still dropped; only the undatable ones survive.
    const rows = [
      { title: 'undated', url: 'https://a.com/1' },
      { title: 'today', url: 'https://b.com/2', date: new Date().toISOString() },
      { title: 'expired', url: 'https://c.com/3', date: new Date(Date.now() - 40 * 86400000).toISOString() },
    ]
    const out = postProcessSearchResults(rows, 10, 1)
    expect(out.map((r) => r.title)).toEqual(['today', 'undated'])
  })

  it('orders dated results newest first, undated last', () => {
    // The older comparator only checked whether a date existed, so two dated rows
    // compared equal and kept provider order — "sorted by date" was not true.
    const rows = [
      { title: 'oldest', url: 'https://a.com/1', date: '2026-11-01' },
      { title: 'newest', url: 'https://b.com/2', date: '2026-11-23' },
      { title: 'middle', url: 'https://c.com/3', date: '2026-11-15' },
      { title: 'undated', url: 'https://d.com/4' },
    ]
    expect(postProcessSearchResults(rows, 10, 0).map((r) => r.title))
      .toEqual(['newest', 'middle', 'oldest', 'undated'])
  })

  it('leaves everything alone when no window is given', () => {
    const rows = [
      { title: 'a', url: 'https://a.com/1', date: iso(400) },
      { title: 'b', url: 'https://b.com/2' },
    ]
    expect(postProcessSearchResults(rows, 10, 0).length).toBe(2)
  })
})
