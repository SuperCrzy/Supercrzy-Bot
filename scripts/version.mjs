#!/usr/bin/env node
/**
 * 版本号唯一源（2026-10-22）
 *
 * 问题：以前同一个产品有四个各自手写的版本号 ——
 *   根 package.json 0.4.1 / client 0.4.1 / server 0.4.1 / desktop 1.2.1，
 *   而 git tag 是 v1.2.0，装机产物是 1.1.3，`/api/system/version` 兜底还写着 '0.3.0'。
 *   谁想改版本都得记住四个地方，漏一个就开始漂。
 *
 * 现在：**根 package.json 的 version 是唯一源**，其余全部由本脚本派生。
 *
 * 用法：
 *   node scripts/version.mjs            # 同步：把根版本写进所有子包
 *   node scripts/version.mjs --check    # 只比对，不一致 exit 1（进 pnpm verify）
 *   node scripts/version.mjs 1.3.0      # 改版本：写根 + 同步全部子包
 *
 * 为什么用正则替换而不是 JSON.parse + stringify：后者会把 package.json 的
 * 手写顺序、空行、缩进全部重排，diff 里出现几百行噪音，真实的版本改动看不见。
 */
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readdirSync, existsSync } from 'fs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT_PKG = join(ROOT, 'package.json')

/** 需要跟随根版本的包（desktop 是 electron-builder 的版本来源，必须一致） */
export function targetPackages() {
  const out = []
  const pkgsDir = join(ROOT, 'packages')
  if (!existsSync(pkgsDir)) return out
  for (const name of readdirSync(pkgsDir)) {
    const p = join(pkgsDir, name, 'package.json')
    if (existsSync(p)) out.push(p)
  }
  return out
}

/**
 * 应用内更新日志所在文件。
 *
 * 目前只有客户端一处（设置 → 关于 → 更新日志，走 UpdatePanel.vue 的 CHANGELOG 数组）。
 * 做成数组是为了将来若桌面端/手机端各自维护一份时，检查能一并覆盖，不用再改脚本。
 */
function changelogFiles() {
  return [join(ROOT, 'packages/client/src/data/changelog.ts')].filter((f) => existsSync(f))
}

/** 该更新日志文件是否已含指定版本的条目 */
function changelogHasVersion(file, version) {
  const src = readFileSync(file, 'utf8')
  // 条目形如 `version: '1.2.4'`；用词边界避免 1.2.4 命中 11.2.4 / 1.2.40
  return new RegExp(`version:\\s*['"]${version.replace(/\./g, '\\.')}['"]`).test(src)
}

export function readVersion(file) {
  const text = readFileSync(file, 'utf8')
  const m = text.match(/^\s*"version"\s*:\s*"([^"]*)"/m)
  return m ? m[1] : ''
}

/** 只替换 version 字段的值，保留文件原有排版 */
export function writeVersion(file, version) {
  const text = readFileSync(file, 'utf8')
  const re = /^(\s*"version"\s*:\s*")[^"]*(")/m
  if (!re.test(text)) return false
  const next = text.replace(re, `$1${version}$2`)
  if (next === text) return false
  writeFileSync(file, next)
  return true
}

/** 半角数字点分三段（允许 -beta.1 这类后缀） */
export function isValidVersion(v) {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(String(v || ''))
}

function main() {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const setTo = args.find((a) => !a.startsWith('-'))

  if (setTo) {
    if (!isValidVersion(setTo)) {
      console.error(`✗ 版本号不合法：${setTo}（要求 x.y.z）`)
      process.exit(1)
    }
    writeVersion(ROOT_PKG, setTo)
    console.log(`→ 根 package.json 版本设为 ${setTo}`)
  }

  const rootVersion = readVersion(ROOT_PKG)
  if (!isValidVersion(rootVersion)) {
    console.error(`✗ 根 package.json 的 version 不合法：'${rootVersion}'`)
    process.exit(1)
  }

  const targets = targetPackages()
  const drift = []
  for (const file of targets) {
    const rel = file.slice(ROOT.length + 1)
    const v = readVersion(file)
    if (v === rootVersion) continue
    if (check) {
      drift.push(`${rel}: ${v} ≠ ${rootVersion}`)
    } else {
      writeVersion(file, rootVersion)
      console.log(`→ ${rel}: ${v} → ${rootVersion}`)
    }
  }

  if (check) {
    if (drift.length) {
      console.error('✗ 版本号漂移（唯一源 = 根 package.json 的 version）：')
      for (const d of drift) console.error(`   ${d}`)
      console.error('  修复：pnpm version:sync')
      process.exit(1)
    }
    // 应用内更新日志必须为当前版本写条目（2026-10-26 加）。
    // 起因：老板发现「所有端的设置 → 更新日志」长期停在旧版本内容 ——
    // changelog.ts 是手写数组，发版时没人记得加，界面上就一直是几个月前的说明。
    // 这是发布流程的缺失环节，不是文案疏漏，所以放进门禁而不是靠提醒。
    const missing = []
    for (const f of changelogFiles()) {
      if (!changelogHasVersion(f, rootVersion)) missing.push(f)
    }
    if (missing.length) {
      console.error(`✗ 更新日志缺少 v${rootVersion} 条目：`)
      for (const f of missing) console.error(`   ${f}`)
      console.error('  修复：按现有条目格式补一条（features / fixes 中英各一份）')
      process.exit(1)
    }
    console.log(`✓ 版本一致：${rootVersion}（${targets.length} 个包）`)
    console.log(`✓ 更新日志已含 v${rootVersion}`)
    return
  }

  if (!targets.length) console.log('（没有子包需要同步）')
  console.log(`✓ 版本 = ${rootVersion}`)
}

// 只有被当脚本执行时才跑 main（被 test import 时不执行）
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
