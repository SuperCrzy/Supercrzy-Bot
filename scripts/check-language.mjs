#!/usr/bin/env node
/**
 * Language policy gate (English-first).
 *
 * Why this exists: the project is an international open-source repo, and v1.2.1 shipped a
 * release body written entirely in Chinese — the very thing a new visitor reads first. The
 * policy in CONTRIBUTING.md says "English first", but a policy nobody enforces rots. This
 * script enforces the *reproducible* half of it.
 *
 * What it checks (hard failures):
 *   1. Release notes bodies in `docs/release-notes/*.md` must NOT be Chinese-only — an English
 *      section must come before any `<details>`/Chinese block.
 *   2. Newly ADDED files must not be Chinese-only. "Chinese-only" means: contains CJK and
 *      contains no ASCII sentence of >= 20 word-ish characters. Ratchet, not a rewrite: files
 *      that already existed are grandfathered via the baseline.
 *
 * What it deliberately does NOT do: fail on every existing Chinese comment. There are ~450 such
 * files; demanding a full translation would block all work and encourage gaming the check.
 * Instead the baseline is a *ceil*: it may only shrink. `--update-baseline` refuses to grow it.
 *
 * Usage:
 *   node scripts/check-language.mjs                 # verify (runs inside pnpm verify)
 *   node scripts/check-language.mjs --report        # list offenders, no exit code
 *   node scripts/check-language.mjs --update-baseline   # shrink the baseline only
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '..')
const BASELINE_FILE = join(ROOT, 'scripts/language-baseline.json')
const RELEASE_DIR = join(ROOT, 'docs/release-notes')

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/
/** A line "counts as English prose" if it has 4+ consecutive ASCII words — enough to tell
 *  `// Fix the parser` from `// 修解析器`. Code lines (identifiers, punctuation) won't match. */
const ENGLISH_WORDS = /[A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){3,}/

const args = new Set(process.argv.slice(2))
const REPORT = args.has('--report')
const UPDATE = args.has('--update-baseline')

let failed = false
const problems = []

// ---------------------------------------------------------------------------
// 1. Release notes: English section must precede the Chinese <details> block
// ---------------------------------------------------------------------------
function checkReleaseNotes() {
  if (!existsSync(RELEASE_DIR)) return
  for (const name of readdirSync(RELEASE_DIR).filter((f) => f.endsWith('.md')).sort()) {
    const src = readFileSync(join(RELEASE_DIR, name), 'utf8')
    const files = `docs/release-notes/${name}`
    const detailsAt = src.search(/<details>/i)
    const head = detailsAt >= 0 ? src.slice(0, detailsAt) : src

    if (!ENGLISH_WORDS.test(head)) {
      problems.push({ file: files, why: detailsAt >= 0
        ? 'nothing English before <details> — the English summary must come first'
        : 'no English prose at all (release notes must be English-first)' })
      continue
    }
    if (CJK.test(head)) {
      // Inline code (`...`) and fenced blocks are examples, not prose — a query string like
      // `query="图像"` is exactly the evidence an English sentence needs to cite. Strip them
      // before looking for stray Chinese.
      const prose = head
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`]*`/g, '')
      if (CJK.test(prose)) {
        const line = prose.split('\n').findIndex((l) => CJK.test(l)) + 1
        problems.push({ file: files, why: `Chinese prose in the English section (line ~${line}) — move it inside <details>` })
      }
    }
    if (detailsAt >= 0 && !/<summary>[^<]*中文[^<]*<\/summary>/i.test(src)) {
      problems.push({ file: files, why: '<details> block must be labelled <summary>中文</summary>' })
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Ratchet over source files
// ---------------------------------------------------------------------------
const SCAN_DIRS = ['packages/client/src', 'packages/server/src', 'packages/desktop', 'scripts']

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.build') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mts|vue|mjs|cjs|js|css)$/.test(name)) out.push(p)
  }
  return out
}

/** Chinese-only file: has CJK but zero lines of English prose. */
function isChineseOnly(text) {
  if (!CJK.test(text)) return false
  return !text.split('\n').some((l) => ENGLISH_WORDS.test(l))
}

function scan() {
  const hits = []
  for (const d of SCAN_DIRS) {
    for (const f of walk(join(ROOT, d))) {
      const rel = relative(ROOT, f)
      try {
        if (isChineseOnly(readFileSync(f, 'utf8'))) hits.push(rel)
      } catch { /* unreadable — ignore */ }
    }
  }
  return hits.sort()
}

let baseline = []
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).files || []
} catch { /* first run */ }
const baselineSet = new Set(baseline)

checkReleaseNotes()
const chineseOnly = scan()
const newOffenders = chineseOnly.filter((f) => !baselineSet.has(f))
const fixed = baseline.filter((f) => !chineseOnly.includes(f))

if (UPDATE) {
  // Ratchet: the baseline may shrink, never grow — but only once a baseline exists.
  // A missing baseline file means "first run": seed it, otherwise the guard is a deadlock
  // (nothing can ever be grandfathered, and the only escape is deleting the guard).
  const firstRun = baseline.length === 0
  if (!firstRun) {
    const grew = newOffenders.filter((f) => !baselineSet.has(f))
    if (grew.length) {
      console.error(`[language] refusing to grow the baseline by ${grew.length} file(s):`)
      for (const f of grew) console.error(`  + ${f}`)
      console.error('\nTranslate these files to English instead, or document why they cannot be.')
      process.exit(1)
    }
  }
  const note = firstRun
    ? 'SEEDED baseline (first run). From now on this list MAY ONLY SHRINK.'
    : 'Chinese-only files grandfathered by the English-first policy. MAY ONLY SHRINK.'
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), note, files: chineseOnly }, null, 2)}\n`)
  console.log(`[language] baseline ${firstRun ? 'seeded' : 'updated'}: ${chineseOnly.length} file(s) (was ${baseline.length})`)
  process.exit(0)
}

if (REPORT) {
  console.log(`Chinese-only files: ${chineseOnly.length} (baseline ${baseline.length}, new ${newOffenders.length})`)
  for (const f of newOffenders) console.log(`  NEW  ${f}`)
  for (const p of problems) console.log(`  FAIL ${p.file}: ${p.why}`)
  if (fixed.length) console.log(`\nNo longer Chinese-only (prune from baseline with --update-baseline): ${fixed.length}`)
  process.exit(0)
}

for (const p of problems) {
  console.error(`✗ ${p.file}\n   ${p.why}`)
  failed = true
}
for (const f of newOffenders) {
  console.error(`✗ ${f}\n   Chinese-only file is not in the baseline — write it in English (see CONTRIBUTING.md)`)
  failed = true
}

if (failed) {
  console.error('\n[language] FAILED — English-first policy (CONTRIBUTING.md).')
  console.error('Fix: write the file in English, or if it is genuinely untranslatable for now,')
  console.error('     document the reason and add it via a reviewed baseline change.')
  process.exit(1)
}

if (fixed.length) {
  console.log(`[language] hint: ${fixed.length} baseline entr(ies) no longer Chinese-only — run --update-baseline to shrink`)
}
console.log(`[language] OK — ${chineseOnly.length} grandfathered, 0 new, release notes English-first`)
