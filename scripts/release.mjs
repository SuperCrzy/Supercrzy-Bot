#!/usr/bin/env node
/**
 * One-command release (2026-10-26).
 *
 * Why this exists: releasing v1.2.4 took about twenty manual steps, and the first
 * six were pure transcription. The same facts had to be written three times, in
 * three shapes, in three places — CHANGELOG.md, docs/release-notes/vX.md, and the
 * in-app changelog.ts — while the last two differed only in tone. Doing that by hand
 * is how 1.2.1 through 1.2.4 all ended up missing from the app's What's-new panel.
 *
 * What it does:
 *
 *   node scripts/release.mjs prepare   Bump versions, draft all three documents from
 *                                      the commits since the last tag, and stop for
 *                                      review. Nothing is committed or pushed.
 *   node scripts/release.mjs ship      Verify, commit, tag, push, wait for CI, then
 *                                      hand over to release-publish.sh.
 *   node scripts/release.mjs status    Where are we: pending commits, CI runs, what
 *                                      the published update feed currently serves.
 *
 * Design decisions worth knowing:
 *
 * - **Drafts, never decides.** Commit subjects are terse and written for engineers.
 *   The generated text is a starting point with the facts already correct (versions,
 *   dates, file names, the bilingual skeleton); the judgement calls stay human. It
 *   prints exactly which files to edit and refuses to `ship` while a TODO marker
 *   remains.
 *
 * - **Refuses to guess the version.** `prepare` requires the number as an argument.
 *   PATCH vs MINOR is a product decision, and a script that infers it from commit
 *   prefixes would get it wrong the first time a `feat:` turned out to be a fix.
 *
 * - **CI wait is bounded and honest.** It polls with a short interval, prints state
 *   transitions only, and gives up with instructions rather than hanging forever.
 */
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'SuperCrzy/Supercrzy-Bot'
/** Marker for text a human must replace. Kept greppable and unique on purpose. */
const TODO = 'RELEASE-TODO:'

const sh = (cmd, opts = {}) =>
  execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim()
const shQuiet = (cmd) => {
  try { return sh(cmd, { stdio: 'pipe' }) } catch { return '' }
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

function die(msg, hint) {
  console.error(c.err(`✗ ${msg}`))
  if (hint) console.error(c.dim(`  ${hint}`))
  process.exit(1)
}

function step(n, total, title) {
  console.log(`\n${c.bold(`=== ${n}/${total} ${title} ===`)}`)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const rootVersion = () => JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

function lastTag() {
  return shQuiet('git describe --tags --abbrev=0') || ''
}

/** Commits since the last tag, newest last. Empty when the tag is at HEAD. */
function pendingCommits(sinceTag) {
  const range = sinceTag ? `${sinceTag}..HEAD` : 'HEAD'
  const out = shQuiet(`git log --no-merges --format=%H%x1f%s%x1f%b%x1e ${range}`)
  if (!out) return []
  return out
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, subject, body = ''] = chunk.split('\x1f')
      return { hash: hash.slice(0, 7), subject: subject.trim(), body: body.trim() }
    })
    .reverse()
}

const TYPE_RE = /^(feat|fix|perf|refactor|docs|chore|test|build|ci)(\([^)]*\))?!?:\s*/i

function classify(commits) {
  const features = []
  const fixes = []
  const other = []
  for (const cm of commits) {
    const m = TYPE_RE.exec(cm.subject)
    const type = (m?.[1] || '').toLowerCase()
    const text = m ? cm.subject.slice(m[0].length) : cm.subject
    if (type === 'feat') features.push({ ...cm, text })
    else if (type === 'fix' || type === 'perf') fixes.push({ ...cm, text })
    else other.push({ ...cm, text })
  }
  return { features, fixes, other }
}

/** First sentence of a commit body, used as the "why" line in the draft */
function gist(body) {
  if (!body) return ''
  const firstPara = body.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim()
  const cut = firstPara.match(/^.{20,160}?[.!?](\s|$)/)
  return (cut ? cut[0] : firstPara).trim()
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function ghToken() {
  const out = shQuiet(
    "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill 2>/dev/null | grep '^password=' | cut -d= -f2-",
  )
  return out
}

async function gh(path, token) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'supercrzy-release',
    },
  })
  return res.json()
}

// ---------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------

function prepare(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) die(`bad version: ${version}`, 'expected MAJOR.MINOR.PATCH')
  const current = rootVersion()
  if (version === current) die(`version is already ${version}`, 'pass the NEXT version')

  const tag = lastTag()
  const commits = pendingCommits(tag)
  if (commits.length === 0) die('nothing to release', `no commits since ${tag || 'the beginning'}`)

  step(1, 5, 'collect')
  const { features, fixes, other } = classify(commits)
  console.log(`  ${commits.length} commit(s) since ${tag || '(no tag)'}: ` +
    c.dim(`${features.length} feat / ${fixes.length} fix / ${other.length} other`))

  step(2, 5, 'bump versions')
  sh(`node scripts/version.mjs ${version}`)
  console.log(c.ok(`  ✓ all packages -> ${version}`))

  const date = today()
  const notesPath = join(ROOT, 'docs/release-notes', `v${version}.md`)
  if (existsSync(notesPath)) die(`${notesPath} already exists`, 'delete it or pick another version')

  step(3, 5, 'draft release notes')
  writeFileSync(notesPath, draftReleaseNotes(version, date, features, fixes, other), 'utf8')
  console.log(c.ok(`  ✓ docs/release-notes/v${version}.md`))

  step(4, 5, 'draft CHANGELOG.md entry')
  prependChangelog(version, date, features, fixes, other)
  console.log(c.ok('  ✓ CHANGELOG.md'))

  step(5, 5, 'draft in-app changelog')
  prependInAppChangelog(version, date, features, fixes)
  console.log(c.ok('  ✓ packages/client/src/data/changelog.ts'))

  console.log(`
${c.bold('Drafted. Nothing committed yet.')}

Edit these three files, replacing every ${c.warn(TODO)} marker with real prose:

  ${c.bold(`docs/release-notes/v${version}.md`)}    user-facing narrative (English + 中文块)
  ${c.bold('CHANGELOG.md')}                          the detailed record (Chinese, for the repo)
  ${c.bold('packages/client/src/data/changelog.ts')} the in-app "What's new" panel (bilingual, formal)

The in-app panel is what users actually read. Keep it to outcomes, not internals.

Then:

  node scripts/release.mjs ship ${version}

That runs the gates, commits, tags, pushes, waits for CI and publishes.
`)
}

function draftReleaseNotes(version, date, features, fixes, other) {
  const bullets = (list, fallback) =>
    list.length
      ? list.map((x) => `- **${x.text}** ${TODO}: one or two sentences on why this matters to a user. (${x.hash})`).join('\n')
      : fallback

  return `## Highlights

${TODO} Summarise the release in two to four short paragraphs. Lead with what a user
notices, not with which file changed. The bullets below are drawn straight from the
commit subjects and are deliberately terse — rewrite them.

## Features

${bullets(features, '_No new user-facing features in this release._')}

## Fixes

${bullets(fixes, '_No fixes in this release._')}

## Engineering

${bullets(other, '_No internal changes worth calling out._')}

## Known limits

${TODO} Anything still broken, unmeasured, or deliberately out of scope. If a fix was
verified only by code inspection and not on a real device, say so here — this is the
section that keeps the release notes honest.

## Install

- **macOS (Apple Silicon)** — download the \`.dmg\`, drag to Applications, right-click → Open on first launch
  (the build is unsigned).
- **Windows (x64)** — run the \`.exe\` setup; SmartScreen will ask once (the installer is unsigned).
- **Web / self-hosted** — Settings → About → *Check for updates* → *Update source* runs \`git pull\` + \`pnpm install\`
  + frontend build for you.

---

<details>
<summary>中文说明</summary>

### 本次亮点

${TODO} 用两三段话说清"用户能感知到什么"。不要写文件路径和测试数字。

### 修复

${fixes.length ? fixes.map((x) => `- ${TODO}：${x.text}`).join('\n') : '_本次无修复。_'}

### 已知限制

${TODO} 仍然存在或未验证的问题。只做了代码检查、没在真机跑过的，必须写在这里。

### 安装

- **macOS（Apple Silicon）** —— 下载 \`.dmg\`，拖进"应用程序"，首次启动右键 → 打开（未签名）。
- **Windows（x64）** —— 运行 \`.exe\` 安装包，SmartScreen 会提示一次（未签名）。
- **Web / 自建** —— 设置 → 关于 → *检查更新* → *更新源* 会替你执行 \`git pull\` + \`pnpm install\` + 前端构建。

</details>
`
}

function prependChangelog(version, date, features, fixes, other) {
  const p = join(ROOT, 'CHANGELOG.md')
  const src = readFileSync(p, 'utf8')
  const section = (title, list, fallback) =>
    list.length
      ? `### ${title}\n\n${list.map((x) => `- ${TODO} **${x.text}**（${x.hash}）`).join('\n')}\n`
      : `### ${title}\n\n${fallback}\n`

  const entry =
    `## v${version} (${date}) — ${TODO} 一句话概括本次主题\n\n` +
    section('新功能', features, '_本次无新功能。_') + '\n' +
    section('修复', fixes, '_本次无修复。_') + '\n' +
    section('工程', other, '_本次无值得单独说明的内部改动。_') + '\n' +
    `${TODO} 已知限制（未在真机验证的部分必须写明）\n\n---\n\n`

  // Insert right before the newest existing version heading
  const i = src.search(/^## v\d+\.\d+\.\d+ /m)
  if (i < 0) die('CHANGELOG.md has no version headings', 'expected at least one "## vX.Y.Z" line')
  writeFileSync(p, src.slice(0, i) + entry + src.slice(i), 'utf8')
}

function prependInAppChangelog(version, date, features, fixes) {
  const p = join(ROOT, 'packages/client/src/data/changelog.ts')
  const src = readFileSync(p, 'utf8')
  const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  const arr = (list, fallback) =>
    list.length
      ? list.map((x) => `      ${q(`${TODO} ${x.text}`)},`).join('\n')
      : `      // ${fallback}`

  const entry = `  {
    version: ${q(version)},
    date: ${q(date)},
    title: ${q(`${TODO} 正式标题（不超过 20 字，面向用户，不写技术细节）`)},
    titleEn: ${q(`${TODO} Formal title in English`)},
    features: [
${arr(features, 'no new features')}
    ],
    featuresEn: [
      ${features.length ? features.map(() => `${q(`${TODO} English feature line`)},`).join('\n      ') : '// no new features'}
    ],
    fixes: [
${arr(fixes, 'no fixes')}
    ],
    fixesEn: [
      ${fixes.length ? fixes.map(() => `${q(`${TODO} English fix line`)},`).join('\n      ') : '// no fixes'}
    ],
  },
`

  const m = src.match(/export const CHANGELOG: ChangelogEntry\[\] = \[\n/)
  if (!m) die('could not find the CHANGELOG array in changelog.ts')
  const at = m.index + m[0].length
  writeFileSync(p, src.slice(0, at) + entry + src.slice(at), 'utf8')
}

// ---------------------------------------------------------------------------
// ship
// ---------------------------------------------------------------------------

async function ship(version) {
  if (rootVersion() !== version) {
    die(`package.json says ${rootVersion()}, not ${version}`, `run: node scripts/release.mjs prepare ${version}`)
  }

  step(1, 6, 'unresolved TODOs')
  const todoFiles = ['docs/release-notes/v' + version + '.md', 'CHANGELOG.md', 'packages/client/src/data/changelog.ts']
    .map((f) => ({ f, n: (readFileSync(join(ROOT, f), 'utf8').match(/RELEASE-TODO:/g) || []).length }))
    .filter((x) => x.n > 0)
  if (todoFiles.length) {
    console.error(c.err('  draft markers remain — the release would ship placeholder text:'))
    for (const x of todoFiles) console.error(`    ${x.f}: ${x.n} ${TODO}`)
    process.exit(1)
  }
  console.log(c.ok('  ✓ no draft markers left'))

  step(2, 6, 'gates')
  sh('pnpm verify', { stdio: 'inherit' })
  console.log(c.ok('  ✓ pnpm verify'))

  step(3, 6, 'commit + tag + push')
  sh(`git add -A ':!output'`)
  const status = shQuiet('git status --porcelain')
  if (status) {
    sh(`git commit -q -F -`, { input: releaseCommitMessage(version) })
    console.log(c.ok('  ✓ release commit created'))
  } else {
    console.log(c.dim('  (nothing to commit)'))
  }
  sh(`git tag -d v${version} 2>/dev/null || true`)
  sh(`git tag -a v${version} -m ${JSON.stringify(`v${version}`)}`)
  sh('git push origin HEAD')
  sh(`git push origin v${version}`)
  console.log(c.ok(`  ✓ pushed main and v${version}`))

  step(4, 6, 'wait for CI')
  const token = ghToken()
  if (!token) die('no GitHub token from git credential helper')
  const ok = await waitForCI(token, version)
  if (!ok) {
    die('CI did not go green', 'inspect: gh run list  — then rerun `node scripts/release.mjs ship ' + version + '` once fixed')
  }
  console.log(c.ok('  ✓ macOS, Windows and CI all green'))

  step(5, 6, 'publish')
  sh(`./scripts/release-publish.sh ${version}`, { stdio: 'inherit' })
  console.log(c.ok('  ✓ update feed + GitHub Release'))

  step(6, 6, 'sync the site')
  console.log(`  Review the bot.html diff printed above. If it looks right:`)
  console.log(`    ${c.bold(`./scripts/release-publish.sh ${version} --publish-bot-html-only`)}`)
  console.log(`\n  ${c.dim('Left manual on purpose: the site page is the one thing a wrong')}`)
  console.log(`  ${c.dim('version string would visibly break, so it keeps its own approval gate.')}\n`)
}

function releaseCommitMessage(version) {
  const tag = lastTag()
  const commits = pendingCommits(tag)
  const { features, fixes } = classify(commits)
  const lines = [`chore(release): v${version}`, '', `${commits.length} commit(s) since ${tag || 'the beginning'}.`]
  if (features.length) lines.push('', 'Features:', ...features.map((x) => `- ${x.text}`))
  if (fixes.length) lines.push('', 'Fixes:', ...fixes.map((x) => `- ${x.text}`))
  return lines.join('\n') + '\n'
}

async function waitForCI(token, version) {
  const INTERVAL = 20_000
  const MAX = 30 * 60_000
  const started = Date.now()
  const seen = new Map()
  while (Date.now() - started < MAX) {
    const runs = await gh('/actions/runs?per_page=12', token)
    const mine = (runs.workflow_runs || []).filter((r) => r.head_branch === `v${version}`)
    for (const r of mine) {
      const prev = seen.get(r.name)
      if (prev !== r.status + (r.conclusion || '')) {
        seen.set(r.name, r.status + (r.conclusion || ''))
        console.log(`  ${r.name}: ${r.status}${r.conclusion ? ' / ' + r.conclusion : ''}`)
      }
    }
    const building = mine.filter((r) => r.status !== 'completed')
    if (mine.length > 0 && building.length === 0) {
      return mine.every((r) => r.conclusion === 'success')
    }
    await new Promise((r) => setTimeout(r, INTERVAL))
  }
  return false
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function status() {
  const tag = lastTag()
  const commits = pendingCommits(tag)
  console.log(c.bold('version'), rootVersion())
  console.log(c.bold('last tag'), tag || '(none)')
  console.log(c.bold('pending'), `${commits.length} commit(s) since ${tag}`)
  if (commits.length) {
    for (const cm of commits.slice(-8)) console.log(`  ${c.dim(cm.hash)} ${cm.subject}`)
    if (commits.length > 8) console.log(c.dim(`  … and ${commits.length - 8} more`))
  }

  const token = ghToken()
  if (token) {
    const runs = await gh('/actions/runs?per_page=5', token)
    console.log(c.bold('\nrecent CI'))
    for (const r of (runs.workflow_runs || []).slice(0, 5)) {
      const mark = r.conclusion === 'success' ? c.ok('✓') : r.conclusion ? c.err('✗') : c.warn('…')
      console.log(`  ${mark} ${r.name} (${r.head_branch}) ${r.status}${r.conclusion ? ' / ' + r.conclusion : ''}`)
    }
  }

  const feed = shQuiet('curl -s --max-time 10 https://updates.supercrzy.com/releases/latest-mac.yml | head -1')
  const site = shQuiet("curl -s --max-time 10 https://supercrzy.com/bot | grep -oE 'v1\\.[0-9]+\\.[0-9]+' | head -1")
  console.log(c.bold('\npublished'))
  console.log(`  update feed  ${feed || '(unreachable)'}`)
  console.log(`  site page    ${site || '(unreachable)'}`)
}

// ---------------------------------------------------------------------------

const [, , cmd, arg] = process.argv
const usage = `
${c.bold('release')} — one-command release

  node scripts/release.mjs prepare <version>   bump + draft the three documents, then stop
  node scripts/release.mjs ship <version>      gates, commit, tag, push, wait for CI, publish
  node scripts/release.mjs status              where things stand

Typical run:

  node scripts/release.mjs prepare 1.2.5
  ${c.dim('# edit the three files it lists, replacing every <!-- TODO ... -->')}
  node scripts/release.mjs ship 1.2.5
  ${c.dim('# review the bot.html diff, then:')}
  ./scripts/release-publish.sh 1.2.5 --publish-bot-html-only
`

if (cmd === 'prepare') prepare(arg)
else if (cmd === 'ship') ship(arg).catch((e) => die(e.message))
else if (cmd === 'status') status().catch((e) => die(e.message))
else console.log(usage)
