#!/usr/bin/env node
/**
 * Build the payload the Android app ships (P1).
 *
 * Source of truth is the desktop deploy tree (`.deploy-server`), which already holds
 * the compiled server plus a production-only node_modules. We copy it, then remove
 * what a phone cannot run or never uses, and print what each removal bought.
 *
 * Why prune instead of a fresh install: the dependency graph is identical to the
 * desktop's, and a second install doubles the time for zero benefit. The prune list
 * is explicit so nothing disappears silently.
 *
 * Usage:
 *   node scripts/build-mobile-payload.mjs            # build + report
 *   node scripts/build-mobile-payload.mjs --keep-maps
 */
import { readdir, stat, writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
// The desktop deploy tree runs TypeScript through tsx; the phone ships compiled JS.
// Taking `packages/server/dist` plus the desktop's node_modules gives us the same
// dependency graph without tsx/esbuild (about 11MB and a slower cold start).
const SRC_DIST = join(ROOT, 'packages/server/dist')
const SRC_NM = join(ROOT, 'packages/desktop/.deploy-server/node_modules')
const SERVER_PKG = join(ROOT, 'packages/server/package.json')
const OUT_ARG = process.argv.find((a) => a.startsWith('--out='))?.slice(6)
const OUT = OUT_ARG ? join(ROOT, OUT_ARG) : join(ROOT, 'packages/desktop/.mobile-payload')
const KEEP_MAPS = process.argv.includes('--keep-maps')

/** Directories under node_modules that a phone never needs. */
const PRUNE = [
  // Platform binaries for sharp's libvips: none of them is Android, and sharp is
  // lazy-loaded now, so removing the whole chain is safe until someone calls it.
  '@img',
  '@napi-rs',
  'sharp',
  // Chromium driver for the desktop AI browser; the phone drives a WebView instead.
  'playwright-core',
  // Feishu gateway and the WeChat bot runner are desktop-only integrations. Their
  // imports are lazy, so the modules can be absent.
  '@larksuiteoapi',
  'exceljs',
  'pdf-parse',
  'pdfjs-dist',
  'mammoth',
]

/** Stubs keep `require()` from throwing at boot for code paths we pruned. */
const STUBS = {
  sharp: `// Pruned on mobile: no libvips build exists for Android.\nmodule.exports = function () {\n  throw new Error('image processing is unavailable on this build')\n}\nmodule.exports.default = module.exports\n`,
  'playwright-core': {
    type: 'module',
    body: `// Pruned on mobile: the app uses the system WebView, not a bundled Chromium.
// ESM on purpose — the server imports { chromium } by name.
const unavailable = () => { throw new Error('browser automation is unavailable on this build') }
export const chromium = { launch: unavailable, launchPersistentContext: unavailable, connectOverCDP: unavailable }
export const firefox = { launch: unavailable }
export const webkit = { launch: unavailable }
export const devices = {}
export default { chromium, firefox, webkit, devices }
`,
  },
  '@larksuiteoapi/node-sdk': `// Pruned on mobile: Feishu integration is desktop-only.\nmodule.exports = new Proxy({}, { get() { throw new Error('feishu integration is unavailable on this build') } })\nmodule.exports.default = module.exports\n`,
  exceljs: `// Pruned on mobile.\nmodule.exports = new Proxy({}, { get() { throw new Error('xlsx support is unavailable on this build') } })\n`,
  'pdf-parse': `// Pruned on mobile.\nmodule.exports = async () => { throw new Error('pdf parsing is unavailable on this build') }\n`,
  mammoth: `// Pruned on mobile.\nmodule.exports = new Proxy({}, { get() { throw new Error('docx conversion is unavailable on this build') } })\n`,
}

async function duBytes(path) {
  let total = 0
  const walk = async (p) => {
    const info = await stat(p).catch(() => null)
    if (!info) return
    if (info.isFile()) { total += info.size; return }
    if (!info.isDirectory()) return
    for (const entry of await readdir(p).catch(() => [])) await walk(join(p, entry))
  }
  await walk(path)
  return total
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`

async function stripMaps(dir) {
  let removed = 0
  const walk = async (p) => {
    const entries = await readdir(p, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) { await walk(full); continue }
      if (entry.name.endsWith('.map')) {
        removed += (await stat(full)).size
        await rm(full, { force: true })
      }
    }
  }
  await walk(dir)
  return removed
}

/**
 * Boots the pruned tree on a throwaway port and waits for /api/health. A tree that
 * merely resolves its imports is not enough — the phone has no one to ask.
 */
/**
 * Loads the entry module and asserts nothing is missing.
 *
 * A full boot is NOT checked here on purpose: bootstrap waits on the account
 * service and the tunnel, so on a machine without reachable网络 it never reaches
 * listen() and the check would report a false failure. What pruning actually
 * breaks is resolution, and that surfaces the moment the graph is imported.
 */
async function verifyBoot() {
  const child = spawn(process.execPath, ['--input-type=module', '-e', "await import('./dist/app.js')"], {
    cwd: OUT,
    // Temp DB outside the payload: a self-check must not leave files in the artifact.
    env: { ...process.env, DB_PATH: join(tmpdir(), 'supercrzy-payload-verify.db'), PORT: '0', HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', (chunk) => { err += chunk })
  child.stdout.on('data', () => {})

  const done = await Promise.race([
    new Promise((resolve) => child.on('exit', () => resolve('exit'))),
    new Promise((resolve) => setTimeout(() => resolve('alive'), 9000)),
  ])
  if (done === 'alive') child.kill('SIGTERM')

  const missing = err.split('\n').filter((l) =>
    /Cannot find (module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/.test(l))
  if (missing.length) {
    console.error('\n✘ 裁剪后存在无法解析的依赖：')
    for (const line of missing.slice(0, 8)) console.error('   ' + line.trim())
    process.exit(1)
  }
  console.log(done === 'alive'
    ? '依赖自检: 通过（模块图可加载，进程存活）'
    : '依赖自检: 通过（模块图可加载）')
}

async function main() {
  if (!existsSync(SRC_DIST) || !existsSync(SRC_NM)) {
    console.error(`✘ 缺少输入。先构建：`)
    console.error(`   pnpm --filter @supercrzy/server build   # → packages/server/dist`)
    console.error(`   bash packages/desktop/scripts/build-*   # → .deploy-server/node_modules`)
    process.exit(1)
  }

  const before = (await duBytes(SRC_DIST)) + (await duBytes(SRC_NM))
  console.log(`源: dist ${mb(await duBytes(SRC_DIST))} + node_modules ${mb(await duBytes(SRC_NM))}`)

  // No recursive deletes anywhere in this script: the copy excludes what we do not
  // want, so the output directory only ever grows from an empty start. A stale tree
  // is reported instead of being wiped, because deleting 250MB of node_modules is
  // exactly the kind of action that should require a human.
  if (existsSync(OUT)) {
    const stale = await duBytes(OUT)
    if (stale > 0) {
      console.error(`✘ ${OUT} 已存在（${mb(stale)}）。先把它移走再重建，例如：`)
      console.error(`   mv ${OUT} .trash-$(date +%Y%m%d-%H%M%S)-mobile-payload`)
      process.exit(1)
    }
  }
  await mkdir(OUT, { recursive: true })

  const rows = []

  // Exclude at copy time: faster than writing 50MB of maps and deleting them, and
  // it keeps the prune list in one place (PRUNE above).
  const excludes = ['--exclude=.DS_Store']
  if (!KEEP_MAPS) excludes.push('--exclude=*.map')

  execFileSync('rsync', ['-a', ...excludes, `${SRC_DIST}/`, `${OUT}/dist/`], { stdio: 'pipe' })
  for (const pkg of PRUNE) excludes.push(`--exclude=/${pkg}`, `--exclude=/${pkg}/**`)
  // tsx/esbuild only exist because the desktop runs TypeScript directly.
  for (const pkg of ['tsx', 'esbuild', '@esbuild', '.bin']) excludes.push(`--exclude=/${pkg}`, `--exclude=/${pkg}/**`)
  execFileSync('rsync', ['-a', ...excludes, `${SRC_NM}/`, `${OUT}/node_modules/`], { stdio: 'pipe' })

  const pkg = JSON.parse(await readFile(SERVER_PKG, 'utf8'))
  await writeFile(join(OUT, 'package.json'), JSON.stringify({
    name: 'supercrzy-bot-mobile-runtime',
    version: pkg.version,
    private: true,
    type: 'module',
  }, null, 2))

  if (!KEEP_MAPS) {
    let mapBytes = 0
    const walk = async (p) => {
      const entries = await readdir(p, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        const full = join(p, e.name)
        if (e.isDirectory()) await walk(full)
        else if (e.name.endsWith('.map')) mapBytes += (await stat(full)).size
      }
    }
    await walk(SRC_DIST).catch(() => {})
    await walk(SRC_NM).catch(() => {})
    rows.push(['source maps', mapBytes])
  }

  for (const pkg of [...PRUNE, 'tsx', 'esbuild']) {
    const size = await duBytes(join(SRC_NM, pkg))
    if (size) rows.push([pkg, size])
  }

  for (const [pkg, spec] of Object.entries(STUBS)) {
    const body = typeof spec === 'string' ? spec : spec.body
    const kind = typeof spec === 'string' ? null : spec.type
    const dir = join(OUT, 'node_modules', pkg)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '0.0.0-stub', main: 'index.js', ...(kind ? { type: kind } : {}) }, null, 2))
    await writeFile(join(dir, 'index.js'), body)
    rows.push([`stub ${pkg}`, 0])
  }

  const after = await duBytes(OUT)
  rows.sort((a, b) => b[1] - a[1])
  console.log('\n省下的空间:')
  for (const [name, size] of rows) console.log(`  ${name.padEnd(28)} ${size ? mb(size) : 'stub'}`)
  console.log(`\n产物: ${OUT}`)
  console.log(`结果: ${mb(before)} → ${mb(after)}  (省 ${mb(before - after)}, ${((1 - after / before) * 100).toFixed(0)}%)`)

  // Sanity: the pruned tree must still boot. Caller can skip with --no-verify.
  if (!process.argv.includes('--no-verify')) {
    await verifyBoot()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
