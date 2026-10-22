/**
 * 版本号单一源（2026-10-22）
 *
 * 缺陷背景：同一个产品四个手写版本号 ——
 *   根 `0.4.1` / client `0.4.1` / server `0.4.1` / desktop `1.2.1`，
 *   git tag 是 `v1.2.0`，装机产物 `1.1.3`，而 `/api/system/version` 兜底写着 `'0.3.0'`。
 * 后果不是"数字不好看"：设置-关于显示 0.3.0 却同时提示"发现新版本"，用户无法判断自己在哪个版本。
 *
 * 这里钉住的是**派生关系**，不是某个具体号：
 * 1. 根 package.json 是唯一源，三个子包必须与它逐字相等；
 * 2. 桌面打包前置必须同步版本（否则 electron-builder 用旧号盖包）；
 * 3. `pnpm verify` 必须跑 `version.mjs --check`（闸门不接线等于没有）；
 * 4. 后端解析版本时不再出现任何写死的假号，且 APP_VERSION 优先（打包形态唯一来源）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import { resolveProductVersion } from './system'

const here = dirname(fileURLToPath(import.meta.url))
// src/routes → src → packages/server → packages → 仓库根
const REPO_ROOT = join(here, '..', '..', '..', '..')
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const readText = (p: string) => readFileSync(p, 'utf8')

const rootPkg = readJson(join(REPO_ROOT, 'package.json'))
const pkgPaths = ['packages/client', 'packages/server', 'packages/desktop'].map((p) => join(REPO_ROOT, p, 'package.json'))

describe('唯一源：根 package.json', () => {
  it('版本号是合法 x.y.z', () => {
    expect(rootPkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  })

  it('🔴 三个子包与根版本逐字相等（不许各自手写）', () => {
    for (const p of pkgPaths) {
      const pkg = readJson(p)
      expect(pkg.version, `${p} 版本漂移：${pkg.version} ≠ ${rootPkg.version}`).toBe(rootPkg.version)
    }
  })
})

describe('闸门必须接线', () => {
  it('pnpm verify 第一步就是 version:check', () => {
    const verify = String(rootPkg.scripts?.verify || '')
    expect(verify).toContain('scripts/version.mjs --check')
    // 必须是第一步：等到跑完 test/build 才发现版本漂移没有任何意义
    expect(verify.indexOf('scripts/version.mjs --check')).toBeLessThan(verify.indexOf('check-clean-tree'))
  })

  it('根有 version:sync / version:check 两个入口', () => {
    expect(rootPkg.scripts?.['version:sync']).toContain('scripts/version.mjs')
    expect(rootPkg.scripts?.['version:check']).toContain('--check')
  })

  it('🔴 桌面打包前置同步版本（electron-builder 读的就是 desktop/package.json）', () => {
    const desktop = readJson(join(REPO_ROOT, 'packages/desktop/package.json'))
    for (const key of ['pack', 'dist']) {
      const cmd = String(desktop.scripts?.[key] || '')
      expect(cmd, `${key} 必须先跑版本同步`).toContain('scripts/version.mjs')
      // 且必须在 electron-builder 之前
      expect(cmd.indexOf('scripts/version.mjs')).toBeLessThan(cmd.indexOf('electron-builder'))
    }
  })
})

describe('后端版本解析', () => {
  it('APP_VERSION 优先（打包形态由主进程注入 app.getVersion()）', () => {
    expect(resolveProductVersion({ APP_VERSION: '9.9.9' } as any)).toBe('9.9.9')
  })

  it('兼容旧部署的 ENGINE_VERSION，但排在 APP_VERSION 之后', () => {
    expect(resolveProductVersion({ ENGINE_VERSION: '8.8.8' } as any)).toBe('8.8.8')
    expect(resolveProductVersion({ APP_VERSION: '9.9.9', ENGINE_VERSION: '8.8.8' } as any)).toBe('9.9.9')
  })

  it('没有环境变量时读本包 package.json（= 根版本）', () => {
    expect(resolveProductVersion({} as any)).toBe(rootPkg.version)
  })

  it('🔴 兜底链里不许再出现写死的假版本号（注释里讲历史不算）', () => {
    const src = readText(join(here, 'system.ts'))
    // 真正的病是「读不到就用假号顶上」：`|| '0.3.0'` / `?? '0.3.0'`
    // 注释里复述历史（"旧实现兜底写 0.3.0"）是无害的，所以只钉表达式形态
    expect(src).not.toMatch(/(\|\||\?\?)\s*'0\.3\.0'/)
    expect(src).not.toMatch(/(\|\||\?\?)\s*"0\.3\.0"/)
  })

  it('🔴 桌面主进程必须把 app.getVersion() 注入后端（否则打包形态读不到 package.json）', () => {
    const main = readText(join(REPO_ROOT, 'packages/desktop/main.cjs'))
    expect(main).toContain('APP_VERSION: app.getVersion()')
  })
})
