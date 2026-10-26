#!/usr/bin/env node
/**
 * Inject `blockMapSize` into electron-updater manifests.
 *
 * Why this is needed
 * ------------------
 * Differential updates only happen when `electron-updater` can find a block map. It looks for
 * `blockMapSize` on each entry of `latest*.yml`; without it the updater does not even request
 * the `.blockmap` file and falls back to downloading the whole archive.
 *
 * electron-builder 25 emits the `.blockmap` files but omits `blockMapSize` from the manifest,
 * so every update in this project has been a full 170 MB download. The block maps were already
 * sitting next to the archives, unused.
 *
 * What it does
 * ------------
 * For each manifest it finds (`latest-mac.yml`, `latest-linux.yml`, `latest.yml`):
 *   - each `files[]` entry whose `url` has a sibling `<url>.blockmap` on disk gets
 *     `blockMapSize: <bytes of that file>`;
 *   - entries without a block map are left untouched (dmg on some builders, etc.).
 * It is idempotent: running twice does not duplicate the key.
 *
 * Usage
 *   node scripts/inject-blockmap-size.mjs <dist-dir> [more-dist-dirs...]
 *   node scripts/inject-blockmap-size.mjs --check <dist-dir>   # exit 1 if anything is missing
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const MANIFESTS = ['latest-mac.yml', 'latest.yml', 'latest-linux.yml', 'beta-mac.yml', 'beta.yml']

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const dirs = args.filter((a) => !a.startsWith('--'))

if (dirs.length === 0) {
  console.error('usage: inject-blockmap-size.mjs [--check] <dist-dir> [...]')
  process.exit(2)
}

let changed = 0
let missing = 0
let inspected = 0

/**
 * Minimal line-based patcher. The manifests are flat YAML written by electron-builder with a
 * rigid shape, so a full YAML round-trip would reformat (and risk reordering) the file. We only
 * insert a line, preserving everything else byte-for-byte.
 */
function patchManifest(file) {
  const src = readFileSync(file, 'utf8')
  const lines = src.split('\n')
  const out = []
  const dir = dirname(file)
  let pendingUrl = null

  for (const line of lines) {
    const urlMatch = /^\s*-\s*url:\s*(.+?)\s*$/.exec(line) || /^\s*path:\s*(.+?)\s*$/.exec(line)
    if (urlMatch) {
      pendingUrl = urlMatch[1].replace(/^['"]|['"]$/g, '')
    }

    // When we reach the entry's `size:` line, append blockMapSize right after it.
    const sizeMatch = /^(\s*)size:\s*(\d+)\s*$/.exec(line)
    if (sizeMatch && pendingUrl) {
      out.push(line)
      const mapPath = join(dir, `${pendingUrl}.blockmap`)
      if (existsSync(mapPath)) {
        const bytes = statSync(mapPath).size
        out.push(`${sizeMatch[1]}blockMapSize: ${bytes}`)
        inspected++
      }
      pendingUrl = null
      continue
    }

    // A repeated blockMapSize from a previous run would double-insert; drop stale ones.
    if (/^\s*blockMapSize:\s*\d+\s*$/.test(line)) continue

    out.push(line)
  }

  const patched = out.join('\n')
  if (patched !== src) {
    changed++
    if (!checkOnly) writeFileSync(file, patched)
    return true
  }
  return false
}

for (const dir of dirs) {
  if (!existsSync(dir)) {
    console.error(`skip (no such dir): ${dir}`)
    continue
  }
  const present = readdirSync(dir).filter((f) => MANIFESTS.includes(f))
  if (present.length === 0) {
    console.log(`${dir}: no updater manifest found`)
    continue
  }
  for (const name of present) {
    const did = patchManifest(join(dir, name))
    console.log(`${join(dir, name)}: ${did ? (checkOnly ? 'WOULD PATCH' : 'patched') : 'unchanged'}`)
  }
}

if (checkOnly) {
  if (changed > 0) {
    console.error(
      `\n[blockmap] ${changed} manifest(s) lack blockMapSize — differential updates would be disabled.` +
        `\nRun without --check to patch.`,
    )
    process.exit(1)
  }
  console.log(`\n[blockmap] OK — ${inspected} entr(ies) carry blockMapSize`)
  process.exit(0)
}

console.log(`\n[blockmap] ${changed} manifest(s) updated, ${inspected} entr(ies) annotated`)
void missing
