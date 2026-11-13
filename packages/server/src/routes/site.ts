/**
 * Same-origin proxy for the site's own pages, used by the app's embedded views.
 *
 * Why this exists: supercrzy.com sends `X-Frame-Options: DENY` + `frame-ancestors 'self'`,
 * so a page there cannot be framed from the app's origin. Rather than weaken the site's
 * headers (or rebuild its pages here and let them drift), we fetch through the local server
 * and serve them from our own origin. The app then embeds `/site/...`, which is same-origin,
 * so framing is allowed by the site's own policy rather than against it.
 *
 * Three things are adjusted on the way through:
 *   1. `X-Frame-Options` is dropped — it has no meaning once we are the origin serving it.
 *   2. Root-absolute URLs in HTML (`/css/...`, `/news/...`) are rewritten to `/site/...`,
 *      otherwise the embedded page would request them from the app and 404.
 *   3. Every successful response is mirrored to disk (`site-cache/`), and a failed fetch
 *      falls back to that mirror. The cross-border link has died whole evenings (2026-11-13);
 *      a stale mirror beats a blank frame every time. Freshness: memory cache 10 min, disk
 *      forever-but-overwritten — the next successful fetch replaces the mirror entry.
 *
 * Only GET/HEAD are proxied.
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { createHash } from 'crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, extname, join, normalize } from 'path'
import { fileURLToPath } from 'url'

const SITE_ORIGIN = (process.env.SUPERCRZY_SITE_ORIGIN || 'https://supercrzy.com').replace(/\/+$/, '')

/**
 * Local copy of the site's own static assets (css/js/fonts + small images), so the embedded
 * pages load their chrome with zero network dependency. The cross-border link to
 * supercrzy.com resets ~every third request (ECONNRESET), which used to blank the whole page
 * whenever main.js failed to arrive. Article cover images stay on the proxy — they are too
 * big to vendor and degrade gracefully.
 *
 * Filled from the SUPERCRZY-v2 working copy (css/js/fonts + images under 200KB). Gitignored:
 * it is a mirror, not a source of truth — refresh it when the site's assets change.
 */
// ESM has no __dirname; derive it from the module URL (same pattern as app.ts).
// src/routes/site.ts → ../../ = packages/server → site-static. Holds after tsc too (dist/routes → ../..).
const __filename = fileURLToPath(import.meta.url)
const SITE_STATIC_DIR = normalize(join(dirname(__filename), '../../site-static'))
const SITE_CACHE_DIR = normalize(join(dirname(__filename), '../../site-cache'))

/** Local file first; the proxy only covers what we do not have on disk. */
function localSiteFile(rest: string): string | null {
  const resolved = normalize(join(SITE_STATIC_DIR, rest))
  if (!resolved.startsWith(SITE_STATIC_DIR)) return null // path traversal
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return null
  return resolved
}

export const siteRouter = new Router({ prefix: '/site' })

/**
 * The site is reached over a cross-border link that drops a noticeable share of requests
 * (33% packet loss was measured on this route). A single fetch therefore fails intermittently
 * — HTML one moment, its JS the next — and a blank frame is the symptom, not a bug in the
 * embed. Retry a few times and cache what lands: same URL is very likely to succeed on a
 * later attempt, and assets should never be re-fetched while switching pages anyway.
 */
const ASSET_CACHE = new Map<string, { ct: string; body: Buffer; at: number }>()
const ASSET_CACHE_TTL_MS = 10 * 60_000
const FETCH_RETRIES = 3

async function fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    try {
      // Hard timeout per attempt: Node's fetch has NO default timeout, and a hung TLS
      // handshake on the cross-border link used to pin the request forever while the
      // client's curl died at 45s. 12s covers the 70KB home page comfortably.
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) })
      if (res.status >= 500 && attempt < FETCH_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
        continue
      }
      return res
    } catch (e) {
      lastErr = e
      if (attempt < FETCH_RETRIES - 1) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
    }
  }
  throw lastErr ?? new Error('fetch failed after retries')
}

function cachedAsset(url: string): { ct: string; body: Buffer } | null {
  const hit = ASSET_CACHE.get(url)
  if (!hit) return null
  if (Date.now() - hit.at > ASSET_CACHE_TTL_MS) {
    ASSET_CACHE.delete(url)
    return null
  }
  return hit
}

/**
 * Disk mirror: every successful proxied response is written here; a failed fetch falls back
 * to it. Key is a content hash of the path (no traversal, no filename collisions). Missing
 * entry or any IO error → null — the mirror is best-effort by design.
 */
function diskKey(rest: string, qs: string): string {
  return createHash('sha1').update(rest).update('?').update(qs).digest('hex').slice(0, 24)
}
function readDiskCache(key: string): { ct: string; body: Buffer } | null {
  try {
    const meta = JSON.parse(readFileSync(join(SITE_CACHE_DIR, `${key}.json`), 'utf8')) as { ct: string }
    const body = readFileSync(join(SITE_CACHE_DIR, `${key}.bin`))
    return { ct: meta.ct, body }
  } catch {
    return null
  }
}
function writeDiskCache(key: string, ct: string, body: Buffer): void {
  try {
    mkdirSync(SITE_CACHE_DIR, { recursive: true })
    writeFileSync(join(SITE_CACHE_DIR, `${key}.json`), JSON.stringify({ ct }))
    writeFileSync(join(SITE_CACHE_DIR, `${key}.bin`), body)
  } catch {
    /* mirror is best-effort; a full disk must never break the proxy */
  }
}

/** Rewrite root-absolute URLs so sub-resources stay inside the proxy. */
export function rewriteRootPaths(html: string): string {
  return (
    html
      // href/src/action="/x"  →  href/src/action="/site/x"   (but not protocol-relative "//x")
      .replace(/(\s(?:href|src|action)=")\/(?!\/)/gi, '$1/site/')
      // srcset is a comma-separated list of "url descriptor" — the browser prefers it over
      // src, so leaving these un-rewritten is exactly why images came back blank.
      .replace(/(\ssrcset=")([^"]*)"/gi, (_m, prefix: string, value: string) => {
        const fixed = value
          .split(',')
          .map((part) => {
            const t = part.trim()
            return t.startsWith('/') && !t.startsWith('//') ? `/site${t}` : t
          })
          .join(', ')
        return `${prefix}${fixed}"`
      })
  )
}

siteRouter.get('/(.*)', async (ctx: Context) => {
  try {
    await handleSiteProxy(ctx)
  } catch (e) {
    // Uncaught errors here close the socket with no response (curl sees exit 7 / 000),
    // which is exactly the symptom that took an hour to trace. Log loudly instead.
    console.error('[site-proxy] unhandled:', e)
    ctx.status = 502
    ctx.body = { error: 'site_proxy_error', message: String(e) }
  }
})

async function handleSiteProxy(ctx: Context) {
  const rest = ctx.path.replace(/^\/site/, '') || '/'
  const url = `${SITE_ORIGIN}${rest}${ctx.querystring ? `?${ctx.querystring}` : ''}`
  const isHtml = /\.(html|\/|)$/.test(rest) || rest === '/'

  // 1) Local static file — css/js/fonts/small images come from disk, no network.
  const local = localSiteFile(rest)
  if (local) {
    ctx.type = extname(local).slice(1) || 'bin'
    ctx.body = createReadStream(local)
    return
  }

  // 2) Non-HTML assets (js/css/images): serve from cache first — the link to the site is lossy
  // and re-fetching every asset on every page switch turns blank frames into roulette.
  if (!isHtml) {
    const hit = cachedAsset(url)
    if (hit) {
      ctx.status = 200
      ctx.set('content-type', hit.ct)
      ctx.body = hit.body
      return
    }
  }

  let upstream: Response
  try {
    upstream = await fetchWithRetry(url, {
      headers: {
        // ⚠️ Desktop Chrome UA, deliberately. Two things were tested side by side:
        //  · iPhone UA → the site returns a ~12KB JS-skeleton whose dynamic boards fetch
        //    data that can never arrive behind the proxy → blank frame.
        //  · no UA (node default) → rejected outright by the site's CDN.
        // Desktop Chrome UA is the only one that returns the full server-rendered page
        // (70249 chars for the home page), and the responsive CSS lays it out for a phone
        // width regardless of what the UA says.
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'accept-language': String(ctx.headers['accept-language'] || 'en'),
      },
    })
  } catch (e: any) {
    // Mirror fallback: a stale copy from disk beats a blank frame or a 502 every time.
    // Applies to HTML and assets alike — the mirror is written on every success below.
    const key = diskKey(rest, ctx.querystring)
    const stale = readDiskCache(key)
    if (stale) {
      ctx.status = 200
      ctx.set('content-type', stale.ct)
      ctx.set('x-site-cache', 'stale')
      ctx.body = stale.body
      return
    }
    ctx.status = 502
    ctx.body = {
      error: 'site_unreachable',
      message: e?.message || String(e),
      cause: String(e?.cause?.code || ''),
    }
    return
  }

  ctx.status = upstream.status
  const ct = upstream.headers.get('content-type') || 'application/octet-stream'
  ctx.set('content-type', ct)

  // Mirror everything that came back OK (fresh bytes win over the disk copy), so the next
  // outage serves this version instead of nothing.
  const dkey = diskKey(rest, ctx.querystring)

  if (ct.includes('text/html')) {
    ctx.set('cache-control', 'no-store')
    const html = rewriteRootPaths(await upstream.text())
    if (upstream.status === 200) writeDiskCache(dkey, ct, Buffer.from(html, 'utf8'))
    ctx.body = html
    return
  }
  // Binary and text assets pass through untouched. Deliberately not forwarding the site's
  // CSP/XFO headers: they describe a different origin than the one now serving this.
  const body = Buffer.from(await upstream.arrayBuffer())
  if (upstream.status === 200) {
    ASSET_CACHE.set(url, { ct, body, at: Date.now() })
    writeDiskCache(dkey, ct, body)
  }
  ctx.body = body
}
