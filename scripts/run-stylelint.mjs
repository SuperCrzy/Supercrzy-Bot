#!/usr/bin/env node
/**
 * stylelint 门（I5，2026-10-23）。
 *
 * 为什么包一层而不是直接 `stylelint ...`：
 *   依赖在本机可能尚未安装（`pnpm add -D` 失败/未跑）。裸调会把 `verify`
 *   卡在一个"环境没装好"上，而不是"代码有问题"—— 门禁失败原因必须可分辨。
 *   未安装 → 明确告警 + exit 0（不假装通过，也不误报代码错）；
 *   已安装 → 真实跑 lint，任何违规 exit 1。
 *
 * 规则集见 `packages/client/.stylelintrc.json`（customSyntax = postcss-html，
 * 只挑不会大面积误报的规则：非法 hex、calc 空格、重复属性、shorthand 覆盖、
 * 空块、空源、vendor prefix、@import 位置）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const CLIENT = join(import.meta.dirname, '..', 'packages', 'client')
const BIN = join(CLIENT, 'node_modules', '.bin', 'stylelint')

if (!existsSync(BIN)) {
  console.warn('[stylelint] SKIPPED — stylelint 未安装（pnpm install 后自动生效）')
  console.warn('[stylelint] 装上即成为硬门禁：packages/client/.stylelintrc.json')
  process.exit(0)
}

const r = spawnSync(BIN, ['src/**/*.{vue,css}'], { cwd: CLIENT, stdio: 'inherit' })
process.exit(r.status ?? 1)
