/**
 * Copy non-TypeScript runtime assets next to the compiled output (2026-10-26).
 *
 * `tsc` only emits `.js` / `.d.ts` / maps — JSON configuration files that the runtime reads
 * with `readFileSync` are left behind. Today there is exactly one such asset:
 *
 *   src/config/tts-relays.bundled.json  →  dist/config/tts-relays.bundled.json
 *
 * It matters more than a normal config file: it is the fallback relay list, i.e. the thing that
 * makes TTS usable in mainland China when the online manifest times out. If it is missing the
 * loader degrades silently to "no relay" — which is precisely the bug it exists to fix — so the
 * build must fail loudly rather than ship without it.
 *
 * Usage: node scripts/copy-assets.mjs [distDir=dist]
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const outDir = resolve(pkgRoot, process.argv[2] || 'dist')

/** source (relative to packages/server) → destination (relative to dist) */
const ASSETS = ['src/config/tts-relays.bundled.json']

let copied = 0
const missing = []

for (const rel of ASSETS) {
  const from = join(pkgRoot, rel)
  if (!existsSync(from)) {
    missing.push(rel)
    continue
  }
  // 'src/config/x.json' → 'config/x.json'
  const to = join(outDir, rel.replace(/^src\//, ''))
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to)
  copied++
  console.log(`[assets] ${rel} → ${to.replace(pkgRoot + '/', '')}`)
}

if (missing.length > 0) {
  console.error(`[assets] missing source file(s): ${missing.join(', ')}`)
  process.exit(1)
}

console.log(`[assets] ${copied} file(s) copied into ${outDir.replace(pkgRoot + '/', '')}`)
