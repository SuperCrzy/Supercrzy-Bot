#!/usr/bin/env node
/**
 * 打包前后端同步闸门（2026-10-22，问题 D2）
 *
 * 背景：electron-builder 的 extraResources 不是从 `packages/server` 直接取的，而是从
 * `packages/desktop/.deploy-server`（一份"依赖已展开成真实文件"的部署副本）。
 * 那份副本靠手工 rsync 维护 ⇒ 会悄悄过期：实测 2026-10-22 时它落后源码 11 处，
 * 其中 `services/agent.ts` 是错的、还缺 `tts-route.ts` / `tts-session.ts` 等 4 个文件。
 * 后果不是"少个新功能"，而是**打出来的包跑的是旧后端**（缺文件还可能直接 import 失败），
 * 而"打了包"看起来一切正常。
 *
 * 所以把同步做成脚本 + 闸门，而不是记得手工 rsync：
 *   node scripts/sync-backend.mjs           # 同步（src + package.json + tsconfig.json）
 *   node scripts/sync-backend.mjs --check   # 只检查，过期则 exit 1（给 CI / 打包前用）
 *
 * 不碰：node_modules（依赖已展开，重装一遍要几分钟且可能断链）、data/、uploads/（用户数据种子）。
 * 删除只发生在 <desktop>/.deploy-server/src 之内 —— 目的是清掉源码里已不存在的旧文件，
 * 否则旧文件会继续被 require 到（这比"少一个文件"更难查）。
 */
import { existsSync, readdirSync, statSync, mkdirSync, copyFileSync, unlinkSync, rmdirSync, readFileSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolve(here, '..')
const repoRoot = resolve(desktopDir, '../..')
const srcRoot = join(repoRoot, 'packages/server')
const deployRoot = join(desktopDir, '.deploy-server')

// 安全闸：目标必须正好是 desktop 下的 .deploy-server，否则宁可不跑（防止误删别处）
if (!deployRoot.endsWith(join('packages', 'desktop', '.deploy-server'))) {
  console.error(`[sync-backend] 目标目录不符合预期，已中止：${deployRoot}`)
  process.exit(2)
}
if (!existsSync(join(srcRoot, 'src'))) {
  console.error(`[sync-backend] 找不到服务端源码：${srcRoot}/src`)
  process.exit(2)
}

/** 需要同步的相对路径（文件或目录） */
const ITEMS = ['src', 'package.json', 'tsconfig.json']
const checkOnly = process.argv.includes('--check')

/** 递归列出目录下所有文件的相对路径 */
function walk(dir, base = dir, includeTests = false) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full, base, includeTests))
    // 测试文件不进部署副本：后端是 tsx 直接跑 src/app.ts，测试永远不会被 import，
    // 带进去只会让包里多出依赖 vitest 的死代码
    else if (st.isFile() && (includeTests || !/\.(test|spec)\.ts$/.test(name))) out.push(relative(base, full))
  }
  return out
}

/** 收集"源码有、部署应该有"的文件清单（相对 packages/server） */
const wanted = []
for (const item of ITEMS) {
  const full = join(srcRoot, item)
  if (!existsSync(full)) continue
  if (statSync(full).isDirectory()) {
    for (const rel of walk(full)) wanted.push(join(item, rel))
  } else {
    wanted.push(item)
  }
}
const wantedSet = new Set(wanted)

const missing = []
const differing = []
for (const rel of wanted) {
  const s = join(srcRoot, rel)
  const d = join(deployRoot, rel)
  if (!existsSync(d)) {
    missing.push(rel)
    continue
  }
  // 先比大小（便宜），大小相同再比字节 —— 只比 mtime 会被"rsync -a 保时间戳"骗过去
  if (statSync(s).size !== statSync(d).size || !readFileSync(s).equals(readFileSync(d))) differing.push(rel)
}

/** 部署侧多出来的文件（源码已删）——只清 src/ 内的 */
const stale = []
const deploySrc = join(deployRoot, 'src')
if (existsSync(deploySrc)) {
  for (const rel of walk(deploySrc, deploySrc, true)) {
    if (!wantedSet.has(join('src', rel))) stale.push(join('src', rel))
  }
}

if (missing.length || differing.length || stale.length) {
  console.log(`[sync-backend] 已过期：缺 ${missing.length} / 差异 ${differing.length} / 多余 ${stale.length}`)
  for (const f of missing.slice(0, 20)) console.log(`  缺   ${f}`)
  for (const f of differing.slice(0, 20)) console.log(`  差异 ${f}`)
  for (const f of stale.slice(0, 20)) console.log(`  多余 ${f}`)
  if (checkOnly) {
    console.error('[sync-backend] --check 失败：请先跑 node scripts/sync-backend.mjs')
    process.exit(1)
  }
  for (const rel of [...missing, ...differing]) {
    const d = join(deployRoot, rel)
    mkdirSync(dirname(d), { recursive: true })
    copyFileSync(join(srcRoot, rel), d)
  }
  for (const rel of stale) {
    const d = join(deployRoot, rel)
    try { unlinkSync(d) } catch { /* 已不存在 */ }
    // 顺手清空空目录（深到浅，最多 3 层，失败无所谓）
    let dir = dirname(d)
    for (let i = 0; i < 3 && dir.startsWith(deploySrc) && dir !== deploySrc; i++) {
      try {
        if (readdirSync(dir).length === 0) { rmdirSync(dir); dir = dirname(dir) } else break
      } catch { break }
    }
  }
  console.log('[sync-backend] 已同步')
} else {
  console.log('[sync-backend] 已是最新')
}

// ---- 前端产物闸门（同一类 bug 的另一半）----
// extraResources 直接取 packages/client/dist：不存在时 electron-builder **不会报错**，
// 打出来的包打开就是空白窗口。所以这里硬拦；过期只警告（重建前必然过期，拦了没法做事）。
const clientDist = join(repoRoot, 'packages/client/dist/index.html')
if (!existsSync(clientDist)) {
  console.error('[sync-backend] packages/client/dist 缺失 —— 打出来的包会是空白窗口')
  console.error('               请先跑：pnpm --filter @supercrzy/client build')
  process.exit(1)
}
let newestSrc = 0
const clientSrc = join(repoRoot, 'packages/client/src')
if (existsSync(clientSrc)) {
  for (const rel of walk(clientSrc, clientSrc, true)) {
    const m = statSync(join(clientSrc, rel)).mtimeMs
    if (m > newestSrc) newestSrc = m
  }
}
if (newestSrc && statSync(clientDist).mtimeMs < newestSrc) {
  console.warn('[sync-backend] 警告：client/dist 比 src 旧 —— 包里会带上前端旧代码，请先 build')
}
