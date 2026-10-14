/**
 * ffmpeg 可执行文件解析（2026-09-20 新建）
 *
 * 背景：`video_edit` 曾在本机是死链——仓库里 `packages/server/bin/ffmpeg` 是 x86_64 的
 * Mach-O，在 arm64 Mac 上 execve 直接 EBADARCH（bad CPU type），且本机没装 Rosetta、
 * PATH 里也没有 ffmpeg。旧代码硬编码 `join(process.cwd(),'bin','ffmpeg')`，于是每一次
 * 调用都必失败，且失败信息只有一句「ffmpeg 启动失败: ...」，用户不知道怎么修。
 *
 * 🔴 2026-10-14：包内那份二进制已**从仓库移除**（x86_64 在 arm64 上不可用 + GPL 分发义务，
 *    见 candidates() 的注释）。本模块因此完全走「解析链 + 安装引导」。
 *
 * 本模块做三件事：
 *  1. 解析链：显式配置 → PATH → 托管安装位（~/.supercrzy/bin）→ 常见包管理器安装位
 *  2. 真跑 `-version` 探测（只看能否执行，不信「文件存在」——存在≠能跑，架构不匹配就是最典型的反例）
 *  3. 全部失败时给出可按步执行的安装提示，而不是裸报错
 *
 * 放 services/ 的原因：调用方既包括 tools/video-edit.ts（tools → services 允许），
 * 也包括 services/wechat-bot-runner.ts（services → services），反过来放 tools/ 会形成
 * services → tools 的反向依赖。
 */
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'

export interface FfmpegProbe {
  path: string
  ok: boolean
  reason: string
}

export interface FfmpegResolution {
  /** 可用的 ffmpeg 绝对路径；全部候选不可用时为 '' */
  path: string
  /** 逐个候选的探测结果（报错时回显给用户，便于定位） */
  tried: FfmpegProbe[]
}

/** 上一次自动解析成功的路径（避免每次调用都 spawn 一次探测） */
let cachedPath: string | null = null

/** 统一的 spawn 失败文案：把 EBADARCH(-86) 这类「架构不匹配」单独说清楚，别让用户猜 */
function fmtSpawnErr(e: any): string {
  const msg = e?.message || 'unknown'
  // macOS 上 execve 一个错误架构的 Mach-O：同步抛 "spawn Unknown system error -86"，
  // 也可能走 error 事件；两条路都要能认出来（实测走的是同步抛）。
  if (/-86|EBADARCH|ENOEXEC|Exec format error|bad CPU type/i.test(msg)) {
    return `架构不匹配（${msg}）：该二进制无法在当前机器运行`
  }
  return `启动失败: ${msg}`
}

/** 探测单个可执行文件：`ffmpeg -version` 能退出 0 才算可用 */
function probe(bin: string, timeoutMs = 8000): Promise<FfmpegProbe> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (ok: boolean, reason: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ path: bin, ok, reason })
    }
    let child: ReturnType<typeof spawn>
    try {
      // 用数组参数，不拼 shell：路径来自设置项，拼 shell 就是命令注入面
      child = spawn(bin, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e: any) {
      // 架构不匹配时 macOS 是同步抛（不是 error 事件），必须在这里也走同一套文案
      done(false, fmtSpawnErr(e))
      return
    }
    timer = setTimeout(() => {
      try { child.kill() } catch {}
      done(false, `探测超时（>${timeoutMs / 1000}s）`)
    }, timeoutMs)
    let err = ''
    child.stderr?.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', (e: any) => { done(false, fmtSpawnErr(e)) })
    child.on('close', (code) => {
      if (code === 0) done(true, 'ok')
      else done(false, `退出码 ${code}${err ? `（${err.slice(0, 200)}）` : ''}`)
    })
  })
}

/** 候选清单，按优先级从高到低 */
function candidates(explicit: string): string[] {
  const list: string[] = []
  const push = (p: string) => { if (p && !list.includes(p)) list.push(p) }
  push(explicit)
  // PATH：交给系统解析（which/where），覆盖 brew / apt / 手动装的多数情况
  push(platform() === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  // 托管安装位：不入库、不污染仓库（仓库里塞 77MB 二进制是开源阻塞项）
  push(join(homedir(), '.supercrzy', 'bin', 'ffmpeg'))
  // 常见包管理器安装位（PATH 未覆盖时的兜底）
  push('/opt/homebrew/bin/ffmpeg')
  push('/usr/local/bin/ffmpeg')
  push('/usr/bin/ffmpeg')
  // 🔴 2026-10-14 移除「包内 bin/ffmpeg」兜底。原因两条，都不是配置问题：
  //   1) 那份二进制是 x86_64 Mach-O，Apple Silicon 上 execve 直接 EBADARCH，本就不可能是可用兜底；
  //   2) 它是 --enable-gpl --enable-version3 构建，随仓库分发会连带 GPL 源码提供义务，
  //      而本工具链在 arm64 上根本用不到它 —— 为一个必然失败的候选背分发义务不划算。
  //      现在一律走「用户自装 + 解析链」，安装引导见 ffmpegInstallHint()。
  return list
}

/** 安装提示：按平台给出可直接复制的命令 */
export function ffmpegInstallHint(): string {
  const p = platform()
  if (p === 'darwin') {
    return [
      'ffmpeg 不可用。任选其一安装：',
      '  1) Homebrew（推荐：自带 libx264 / libass，video_edit 的压缩与字幕功能都可用）',
      '     brew install ffmpeg',
      '  2) 官方构建页（LGPL / GPL 构建可选，按页面许可证说明自选）：',
      '     https://ffmpeg.org/download.html',
      '  3) 已装在别处：设置 → ffmpegPath 填绝对路径',
      '注：supercrzy 不再随包内置 ffmpeg（旧内置件是 x86_64，Apple Silicon 上无法运行）。',
    ].join('\n')
  }
  if (p === 'win32') {
    return [
      'ffmpeg 不可用。任选其一安装：',
      '  1) winget install ffmpeg',
      '  2) 官方构建页：https://ffmpeg.org/download.html（选 full build 以含 libx264 / libass）',
      '  3) 已装在别处：设置 → ffmpegPath 填 ffmpeg.exe 的绝对路径',
    ].join('\n')
  }
  return [
    'ffmpeg 不可用。任选其一安装：',
    '  1) sudo apt install ffmpeg（Debian/Ubuntu）或 sudo yum install ffmpeg（RHEL 系）',
    '  2) 已装在别处：设置 → ffmpegPath 填绝对路径',
  ].join('\n')
}

/**
 * 解析可用的 ffmpeg。
 * @param explicit 显式指定（来自设置项 ffmpegPath / 环境变量 FFMPEG_PATH）；给定时优先且不使用缓存
 */
export async function resolveFfmpeg(explicit?: string): Promise<FfmpegResolution> {
  const want = String(explicit || '').trim()
  if (!want && cachedPath && existsSync(cachedPath)) {
    return { path: cachedPath, tried: [{ path: cachedPath, ok: true, reason: '缓存命中' }] }
  }
  const tried: FfmpegProbe[] = []
  for (const bin of candidates(want)) {
    if (bin !== 'ffmpeg' && bin !== 'ffmpeg.exe' && !existsSync(bin)) {
      tried.push({ path: bin, ok: false, reason: '文件不存在' })
      continue
    }
    const r = await probe(bin)
    tried.push(r)
    if (r.ok) {
      if (!want) cachedPath = bin
      return { path: bin, tried }
    }
  }
  return { path: '', tried }
}

/** 测试用：清掉缓存 */
export function __resetFfmpegCache(): void { cachedPath = null }
