import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 必须在导入 workspace 模块前设置 WORKSPACE_DIR（模块加载时计算 WORKSPACE_ROOT）
const wsRoot = mkdtempSync(join(tmpdir(), 'supercrzy-ws-test-'))
process.env.WORKSPACE_DIR = wsRoot

let safePath: (input: string) => string | null
/**
 * ⚠️ 必须给这个 hook 显式超时（默认 `hookTimeout` 只有 10s）。
 *
 * 2026-09-28 实测：本文件单跑时 import 约 2.2s，但**全量并行**下会超过 10s
 * ⇒ `Hook timed out in 10000ms`，**整个文件的 9 条用例全部被记成 skipped、文件记成 failed**。
 * 症状很有欺骗性：单跑永远绿，只有 `pnpm verify` 全量时才时红时绿，失败信息也只说"Hook timed out"。
 *
 * 根因是**本机模块加载本身就很贵**（同一台机器上 `require('jsdom')` 实测 **46.7s**，
 * 而 `new JSDOM()` 只要 42ms —— 贵在解析/加载，不在实例化）。所以
 * "**动态 import 重模块**"的 hook 必须给显式超时，别再吃 10s 的默认值。
 */
beforeAll(async () => {
  const mod = await import('../routes/workspace')
  safePath = mod.safePath
}, 60_000)

describe('safePath 路径白名单（防目录穿越）', () => {
  it('合法相对路径可解析', () => {
    const abs = safePath('packages/server/package.json')
    expect(abs).toBe(join(wsRoot, 'packages/server/package.json'))
  })

  it('空串拒绝，点号解析为 workspace 根', () => {
    // 实现：空串直接拒绝（路由层用 dirInput || '.' 兜底，不会走到空串）
    expect(safePath('')).toBeNull()
    expect(safePath('.')).toBe(wsRoot)
  })

  it('根目录自身合法', () => {
    expect(safePath(wsRoot)).toBe(wsRoot)
  })

  it('拦截 ../ 向上穿越', () => {
    expect(safePath('../../etc/passwd')).toBeNull()
    expect(safePath('../secret')).toBeNull()
  })

  it('拦截绝对路径逃逸', () => {
    expect(safePath('/etc/passwd')).toBeNull()
    // 双斜杠前缀也会被 resolve 为根路径，必须拦截
    expect(safePath('//etc/passwd')).toBeNull()
  })

  it('Windows 盘符路径在类 Unix 上不会逃逸出 workspace', () => {
    // C:\Windows 在 POSIX 上只是普通相对路径，会被拼进 workspace 内（安全）
    const abs = safePath('C:\\Windows')
    expect(abs).toBe(join(wsRoot, 'C:\\Windows'))
  })

  it('拦截 NUL 字符注入', () => {
    expect(safePath('a\u0000b')).toBeNull()
  })

  it('拦截符号链接式写法（含 .. 的复合路径）', () => {
    expect(safePath('packages/../../node_modules')).toBeNull()
  })

  it('前缀欺骗不通过（workspace 名作前缀逃逸）', () => {
    // 构造一个与 wsRoot 同前缀但确实在外的路径
    const evil = wsRoot + '-evil'
    expect(safePath(evil)).toBeNull()
  })
})
