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
    console.log(`✓ 版本一致：${rootVersion}（${targets.length} 个包）`)
    return
  }

  if (!targets.length) console.log('（没有子包需要同步）')
  console.log(`✓ 版本 = ${rootVersion}`)
}

// 只有被当脚本执行时才跑 main（被 test import 时不执行）
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
