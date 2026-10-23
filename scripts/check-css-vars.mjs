#!/usr/bin/env node
/**
 * CSS custom-property guard (I4).
 *
 * Why: `var(--typo)` on an undeclared property makes the whole declaration invalid, so the
 * browser silently drops it — colour/border/spacing go wrong with no error anywhere. This has
 * already happened in this repo (`--text-2`, `--border`, `--text-color`). There is no lint that
 * catches it: stylelint does not know about cross-file declarations by default.
 *
 * Rules:
 *   - declared  = any `--name:` occurrence in client .vue/.css (plus index.html)
 *   - used      = any `var(--name` occurrence in the same files
 *   - FAIL when a used name is undeclared, not runtime-injected, and not in the baseline
 *   - FAIL when a used name is undeclared and has NO fallback (always a real bug — nothing to
 *     fall back to, the declaration is simply dropped)
 *   - WARN for baseline entries (known legacy: undeclared but with a fallback) and for baseline
 *     entries that are no longer used (should be pruned)
 *
 * Usage:
 *   node scripts/check-css-vars.mjs            # verify (CI)
 *   node scripts/check-css-vars.mjs --list     # print every used/declared pair
 *   node scripts/check-css-vars.mjs --write-baseline
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = 'packages/client'
const SRC = join(ROOT, 'src')
const BASELINE_FILE = 'scripts/css-var-baseline.json'

/**
 * Properties written from JavaScript at runtime (inline style / setProperty). They can never be
 * found as a CSS declaration, so they are legitimate by construction.
 * Keep this list short and documented — every entry here is an exception.
 */
const RUNTIME_VARS = new Set([
  'chat-input-h', // ChatView.vue:782 — inline :style from the measured input height
  'sidebar-w',    // MainLayout.vue:2 — inline :style from the user's sidebar width
  'dp-zoom',      // DocxPreview.vue:58 — el.style.setProperty during fit()
])

const EXTS = ['.vue', '.css', '.html']
const USE_RE = /var\(\s*--([A-Za-z0-9_-]+)\s*(,)?/g
const DECL_RE = /(?:^|[;{\s])--([A-Za-z0-9_-]+)\s*:/g

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXTS.some((e) => name.endsWith(e)) && name !== 'index.html') out.push(p)
  }
  return out
}

const files = walk(SRC)
const indexHtml = join(ROOT, 'index.html')
try {
  if (statSync(indexHtml).isFile()) files.push(indexHtml)
} catch { /* no index.html — fine */ }

const declared = new Set()
const used = new Map() // name -> { count, withFallback, withoutFallback, files:Set }

for (const f of files) {
  // Comments are not code: `/* ... var(--foo) ... */` must not count as a usage (a fix note that
  // mentions the old name would otherwise fail the guard forever).
  const txt = readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  for (const m of txt.matchAll(DECL_RE)) declared.add(m[1])
  for (const m of txt.matchAll(USE_RE)) {
    const name = m[1]
    const fb = !!m[2]
    const rec = used.get(name) || { count: 0, withFallback: 0, withoutFallback: 0, files: new Set() }
    rec.count += 1
    if (fb) rec.withFallback += 1
    else rec.withoutFallback += 1
    rec.files.add(relative(ROOT, f))
    used.set(name, rec)
  }
}

const undeclared = [...used.entries()]
  .filter(([n]) => !declared.has(n) && !RUNTIME_VARS.has(n))
  .sort((a, b) => a[0].localeCompare(b[0]))

if (process.argv.includes('--list')) {
  console.log(`declared=${declared.size} used=${used.size} undeclared=${undeclared.length}\n`)
  for (const [n, r] of undeclared) {
    console.log(`  --${n.padEnd(24)} x${String(r.count).padEnd(3)} fb=${r.withFallback} nofb=${r.withoutFallback}  ${[...r.files].slice(0, 3).join(', ')}`)
  }
  process.exit(0)
}

if (process.argv.includes('--write-baseline')) {
  const vars = undeclared.filter(([, r]) => r.withoutFallback === 0).map(([n]) => n)
  writeFileSync(BASELINE_FILE, `${JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), vars }, null, 2)}\n`)
  console.log(`[css-vars] baseline written: ${vars.length} known legacy vars -> ${BASELINE_FILE}`)
  process.exit(0)
}

let baseline = []
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')).vars || []
} catch { /* first run */ }
const baselineSet = new Set(baseline)

const hard = []   // must fail: no fallback at all
const fresh = []  // must fail: new undeclared (not in baseline)
const legacy = [] // warn only: baseline entries still around

for (const [name, r] of undeclared) {
  if (r.withoutFallback > 0) hard.push([name, r])
  else if (baselineSet.has(name)) legacy.push([name, r])
  else fresh.push([name, r])
}

const staleBaseline = baseline.filter((n) => !used.has(n))

// ---- 僵尸变量守门（I5，2026-10-23）：声明了却没人用 = 死重 ----
// tokens 曾攒出 16 个零引用 token（shadow 全家 / space-xl 以上 / text-md、xl / info / border-focus…）。
// 规则：声明 − 使用 = 僵尸；`--n-*` 例外 —— 那是 Naive UI 组件的运行时内部变量
// （--n-color / --n-text-color 等），由组件自己消费，源码里 grep 不到 var() 引用，属正常形态。
const ZOMBIE_ALLOW_PREFIX = ['n-']
const zombies = [...declared].filter((n) => !used.has(n) && !ZOMBIE_ALLOW_PREFIX.some((p) => n.startsWith(p)))

if (zombies.length) {
  console.error('\n[css-vars] FAILED — declared custom properties nobody uses (zombie tokens):')
  for (const n of zombies) console.error(`  ✗ --${n}  declared but never referenced  (declare it when a consumer appears, not before)`)
  console.error('\nFix: delete the declaration, or start using the token, or (Naive UI runtime vars only) extend ZOMBIE_ALLOW_PREFIX.')
  process.exit(1)
}

for (const [n, r] of legacy) {
  console.warn(`[css-vars] legacy  --${n.padEnd(22)} x${r.count}  fallback=${r.withFallback} (has default, no declaration)`)
}
if (staleBaseline.length) {
  console.warn(`[css-vars] baseline entries no longer used (prune them): ${staleBaseline.join(', ')}`)
}

if (hard.length || fresh.length) {
  console.error('\n[css-vars] FAILED — undeclared custom properties are silently dropped by the browser:')
  for (const [n, r] of hard) {
    console.error(`  ✗ --${n}  used ${r.count}x, NO fallback  →  ${[...r.files].slice(0, 3).join(', ')}`)
  }
  for (const [n, r] of fresh) {
    console.error(`  ✗ --${n}  used ${r.count}x (new, not in baseline)  →  ${[...r.files].slice(0, 3).join(', ')}`)
  }
  console.error('\nFix: use an existing token from src/styles/tokens.css, or declare the property,')
  console.error('or (JS-injected only) add it to RUNTIME_VARS in this script.')
  process.exit(1)
}

console.log(`[css-vars] OK — ${declared.size} declared, ${used.size} used, ${legacy.length} legacy with fallback (baseline), 0 zombies`)
