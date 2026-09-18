/**
 * 项目会诊 · 扫盘单测（2026-09-18）
 *
 * 背景：scanProject 原本是 readdirSync + statSync + readFileSync 的同步递归，会把事件循环
 * 连同前台对话的 SSE 一起冻住。改成 fs/promises 后，**裁剪语义必须一个字都不变**——
 * 否则要么扫进 node_modules（爆炸），要么漏掉文件（审计结论不可信）。
 * 这里锁死四个裁剪点：跳过目录、扩展名白名单、单文件大小上限、文件总数上限。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { scanProject } from './project-audit'

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'crzy-scan-'))
})
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** 造一组文件（值 = 内容） */
function make(files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
}

describe('scanProject 裁剪语义', () => {
  it('只收白名单扩展名的文件', async () => {
    make({ 'a.ts': 'const a = 1', 'b.py': 'x = 1', 'c.png': 'binary', 'd.exe': 'bin' })
    const out = await scanProject(root)
    expect(out.map((f) => f.rel).sort()).toEqual(['a.ts', 'b.py'])
  })

  it('跳过 node_modules / dist / .git 等目录（否则会扫爆）', async () => {
    make({
      'src/a.ts': 'a',
      'node_modules/pkg/index.ts': 'huge',
      'dist/bundle.ts': 'built',
      '.git/objects/x.ts': 'git',
      '.workbuddy/memory/a.ts': 'mem',
    })
    const out = await scanProject(root)
    expect(out.map((f) => f.rel)).toEqual(['src/a.ts'])
  })

  it('preview 截断到 700 字符，bytes 记完整长度', async () => {
    const long = 'x'.repeat(3000)
    make({ 'big.ts': long })
    const [f] = await scanProject(root)
    expect(f.preview.length).toBe(700)
    expect(f.bytes).toBe(3000)
  })

  it('单文件超过 60KB 直接跳过（不进 preview）', async () => {
    make({ 'small.ts': 'ok', 'huge.ts': 'y'.repeat(61 * 1024) })
    const out = await scanProject(root)
    expect(out.map((f) => f.rel)).toEqual(['small.ts'])
  })

  it('文件总数上限 60：超出的不返回（保证喂给模型的量可控）', async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 200; i++) files[`f${String(i).padStart(3, '0')}.ts`] = 'x'
    make(files)
    const out = await scanProject(root)
    expect(out.length).toBe(60)
  })

  it('rel 是相对 root 的路径，不是绝对路径', async () => {
    make({ 'a/b/c.ts': 'x' })
    const [f] = await scanProject(root)
    expect(f.rel).toBe('a/b/c.ts')
    expect(f.rel.startsWith('/')).toBe(false)
  })

  it('目录不存在 / 不可读时返回空数组而不是抛错', async () => {
    expect(await scanProject(join(root, 'nope'))).toEqual([])
  })

  it('返回 Promise（async）——这正是"不再同步占住事件循环"的标志', async () => {
    make({ 'a.ts': 'x' })
    const p = scanProject(root)
    expect(typeof p.then).toBe('function')
    await p
  })

  it('深层嵌套能正确递归', async () => {
    make({ 'a/b/c/d/e.ts': 'deep' })
    const out = await scanProject(root)
    expect(out.map((f) => f.rel)).toEqual(['a/b/c/d/e.ts'])
  })
})
