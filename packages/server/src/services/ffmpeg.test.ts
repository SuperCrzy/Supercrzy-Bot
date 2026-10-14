/**
 * ffmpeg 解析测试（2026-09-20）
 *
 * 不变量（不是代理指标，也不是恒真断言）：
 *  1. 显式给一个「能跑」的可执行文件 → 必须选中它
 *  2. 存在但跑不起来的二进制（退出码非 0 / 架构不匹配）→ 必须被筛掉，不许选中它。
 *     这是修死链的核心：文件存在 ≠ 可执行，仓库里那份 x86_64 ffmpeg 就是最典型的反例
 *  3. 全部不可用 → 回显每个候选的失败原因，并给出可照抄的安装提示
 *
 * 刻意不写「本机恰好装了 ffmpeg 所以能解析出来」这类依赖环境的断言——那会让 CI 随机红。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, existsSync, mkdirSync, chmodSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveFfmpeg, ffmpegInstallHint, __resetFfmpegCache } from './ffmpeg'

const BUNDLED = join(process.cwd(), 'bin', 'ffmpeg')

describe('resolveFfmpeg', () => {
  beforeEach(() => { __resetFfmpegCache() })

  it('显式指定的可执行文件能跑 → 选中它', async () => {
    // 造一个「不管传什么参数都退出 0」的假二进制（node 自身不接受 -version，不能用 process.execPath 代替）
    const dir = join(tmpdir(), `ffprobe-ok-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const fake = join(dir, 'ffmpeg')
    writeFileSync(fake, '#!/bin/sh\nexit 0\n', 'utf-8')
    chmodSync(fake, 0o755)
    try {
      const r = await resolveFfmpeg(fake)
      expect(r.path).toBe(fake)
      expect(r.tried[0].ok).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('显式指定但文件不存在 → 拒绝', async () => {
    const r = await resolveFfmpeg('/definitely/not/here/ffmpeg-xyz')
    expect(r.path).not.toBe('/definitely/not/here/ffmpeg-xyz')
    expect(r.tried[0].reason).toMatch(/文件不存在|启动失败|退出码|无法启动/)
  })

  it('存在但退出码非 0 → 必须筛掉（不能只看文件是否存在）', async () => {
    const dir = join(tmpdir(), `ffprobe-test-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const fake = join(dir, 'ffmpeg')
    writeFileSync(fake, '#!/bin/sh\necho "not a real ffmpeg" >&2\nexit 7\n', 'utf-8')
    chmodSync(fake, 0o755)
    try {
      const r = await resolveFfmpeg(fake)
      expect(r.path).not.toBe(fake)
      expect(r.tried[0].ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // 🔴 2026-10-14：包内 ffmpeg 已从仓库移除。原因：x86_64 Mach-O 在 Apple Silicon 上
  // execve 直接 EBADARCH（本就不可能是可用兜底），且它是 --enable-gpl --enable-version3
  // 构建，随仓库分发会连带 GPL 源码提供义务。
  //
  // 这条是**防线断言**，不是描述现状：一旦有人把二进制塞回 packages/server/bin/，它会立刻失败。
  // 变红时正确做法是删掉那个二进制，而不是删掉这条断言。
  it('仓库不应再内置 ffmpeg 二进制', () => {
    expect(existsSync(BUNDLED)).toBe(false)
  })

  it('全部不可用 → 回显候选失败原因', async () => {
    const r = await resolveFfmpeg('/definitely/not/here/ffmpeg-xyz')
    expect(r.tried.length).toBeGreaterThan(0)
    for (const t of r.tried) expect(typeof t.reason).toBe('string')
  })
})

describe('ffmpegInstallHint', () => {
  it('给出可直接执行的安装命令，且不指向特定第三方预编译包', () => {
    const hint = ffmpegInstallHint()
    expect(hint.length).toBeGreaterThan(20)
    // 三条分支都要告诉用户「已装在别处可以填绝对路径」
    expect(hint).toContain('ffmpegPath')
    if (process.platform === 'darwin') {
      expect(hint).toContain('brew install ffmpeg')
      expect(hint).toContain('https://ffmpeg.org/download.html')
      // 不变量：曾指向 eugeneware/ffmpeg-static（GPL 构建），不应再被推荐回去
      expect(hint).not.toContain('ffmpeg-static')
    }
  })
})
