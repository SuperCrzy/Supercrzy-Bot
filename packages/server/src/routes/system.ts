/**
 * System API — 版本信息 + 一键更新
 * 仅允许 localhost 调用（防止远程滥用）
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { safeWriteSse, endSseStream, registerSseStream, getSseStats, resetSseStats } from '../services/sse-health'
import { getEventLoopStats, resetEventLoopStats } from '../services/event-loop-lag'

const execAsync = promisify(exec)

// 仓库根目录：从后端 cwd 上溯，直到找到 pnpm-workspace.yaml
function findProjectRoot(start: string): string {
  let dir = start
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start // 到根了还没找到，回退 cwd
    dir = parent
  }
}
const PROJECT_ROOT = findProjectRoot(process.cwd())
/**
 * 2026-10-26: the source-update channel only exists in a git work tree.
 * Packaged desktop app and the Android chroot deployment ship dist/ + node_modules
 * with no .git, so every git call there fails — reporting "no update" for that state
 * was a false claim. Expose the fact so the client can drop the whole source block.
 */
const GIT_AVAILABLE = existsSync(join(PROJECT_ROOT, '.git'))

export const systemRouter = new Router({ prefix: '/api/system' })

/**
 * 产品版本（2026-10-22 统一口径）。
 *
 * 优先级：
 * 1. `APP_VERSION` —— 桌面主进程 spawn 后端时注入 `app.getVersion()`，
 *    打包形态下这就是 Info.plist 里的版本，与 app:info 同源；部署脚本也可显式注入。
 * 2. 本包 package.json 的 version —— 源码/dev 形态（由 scripts/version.mjs 从根派生）。
 * 3. `'unknown'` —— 读不到就说读到不到，**不再假装一个版本号**。
 *
 * 旧实现兜底写死 `'0.3.0'`：那是个从没发布过的号，于是「关于页显示 0.3.0」
 * 与「更新横幅说发现 1.0.6」并排打架，还被当成"已是最新"的判断依据。
 *
 * `ENGINE_VERSION` 保留兼容：老部署脚本设的是它，但不再是首选。
 */
let _productVersion: string | null = null

export function resolveProductVersion(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = String(env.APP_VERSION || env.ENGINE_VERSION || '').trim()
  if (fromEnv) return fromEnv
  if (_productVersion) return _productVersion
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const v = String(pkg?.version || '').trim()
    if (v) {
      _productVersion = v
      return v
    }
  } catch { /* 打包形态可能没有 package.json —— 交给 APP_VERSION */ }
  return 'unknown'
}

/** 仅 localhost 访问保护 */
function isLocalhost(ctx: Context): boolean {
  const ip = ctx.ip || ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')
}

/**
 * 获取当前 git commit hash。
 *
 * 2026-09-18：由 execSync 改 async exec。execSync 会**同步**等子进程，把事件循环整体冻住——
 * 同一台后端的并发 SSE 流在这段时间里一个字节都推不出去。git 命令在冷启动/大仓库下几百毫秒起步，
 * git fetch 在网络慢时能顶满 8 秒超时（check-update）。这类"看起来像 SSE 卡住"的现象，
 * 真凶往往是它，所以系统命令一律走异步。
 */
async function getGitHead(): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT, timeout: 5000 })
    return stdout.toString().trim()
  } catch {
    return 'unknown'
  }
}

// 当前版本信息
systemRouter.get('/version', async (ctx: Context) => {
  let branch = 'unknown'
  try {
    const { stdout } = await execAsync('git branch --show-current', { cwd: PROJECT_ROOT, timeout: 5000 })
    branch = stdout.toString().trim()
  } catch { /* 非 git 目录/命令不可用 → 保持 unknown */ }

  ctx.body = {
    // 产品版本（一个产品一个号，2026-10-22 统一）。
    // 唯一源 = 根 package.json 的 version，由 scripts/version.mjs 派生到各子包；
    // 桌面端启动后端时注入 APP_VERSION = app.getVersion()，因此打包形态下
    // 这里的值与 app:info / 设置-关于 完全同源。
    // 旧实现在这里兜底写 '0.3.0' —— 一个从来没发布过的号，才导致"关于页 0.3.0、
    // 横幅说 1.0.6、tag 是 v1.2.0"三处打架。
    version: resolveProductVersion(),
    gitHead: await getGitHead(),
    branch,
    gitAvailable: GIT_AVAILABLE,
  }
})

// 检查是否有更新：git fetch 后比较本地/远程 HEAD
systemRouter.get('/check-update', async (ctx: Context) => {
  if (!isLocalhost(ctx)) {
    ctx.status = 403
    ctx.body = { error: 'Forbidden' }
    return
  }
  // No .git → nothing to fetch, and every git call below would just time out.
  // Say so explicitly instead of letting it fall through to "remote-unavailable".
  if (!GIT_AVAILABLE) {
    ctx.body = { hasUpdate: false, localHead: 'unknown', remoteHead: null, reason: 'not-a-repo', gitAvailable: false }
    return
  }
  const localHead = await getGitHead()
  try {
    // 先尝试获取远程（不拉取代码，只更新远程跟踪分支）；GIT_TERMINAL_PROMPT=0 防凭据交互卡死；8s 超时避免弹窗久等
    // 注意：这里必须是 async exec——execSync 会把事件循环连同所有并发 SSE 流一起冻住最多 8 秒
    await execAsync('GIT_TERMINAL_PROMPT=0 git fetch origin', { cwd: PROJECT_ROOT, timeout: 8000 })
    const { stdout: remoteOut } = await execAsync('git rev-parse --short origin/main 2>/dev/null || git rev-parse --short origin/HEAD 2>/dev/null || echo unknown', { cwd: PROJECT_ROOT, timeout: 5000 })
    const remoteHead = remoteOut.toString().trim()
    if (remoteHead === 'unknown') {
      ctx.body = { hasUpdate: false, localHead, remoteHead: null, reason: 'no-remote-branch', message: '远程分支不可用', gitAvailable: true }
      return
    }
    const hasUpdate = remoteHead !== localHead
    ctx.body = { hasUpdate, localHead, remoteHead, reason: hasUpdate ? 'behind' : 'latest', gitAvailable: true }
  } catch (err: any) {
    // 远程不可达（仓库不存在/无网络）→ 无法检查，不再谎称「已是最新」
    ctx.body = { hasUpdate: false, localHead, remoteHead: null, reason: 'remote-unavailable', message: (err.message || '').split('\n')[0]?.slice(0, 100) || '远程不可达', gitAvailable: true }
  }
})

// 一键更新：commit 当前改动 → git pull → 安装依赖 → 构建前端
systemRouter.post('/update', async (ctx: Context) => {
  if (!isLocalhost(ctx)) {
    ctx.status = 403
    ctx.body = { error: 'Forbidden: only localhost allowed' }
    return
  }

  ctx.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  ctx.status = 200
  ctx.respond = false
  safeWriteSse(ctx, ': connected\n\n')
  registerSseStream(ctx, 'system-update')

  const send = (step: string, message: string, ok?: boolean) => {
    safeWriteSse(ctx, `data: ${JSON.stringify({ step, message, ok: ok ?? null })}\n\n`)
  }

  const steps: Array<{ name: string; cmd: string; cwd?: string; tolerant?: boolean }> = [
    { name: '提交当前改动', cmd: 'git add -A && git commit -m "chore: auto commit before update $(date +%Y%m%d-%H%M%S)" --no-verify' },
    { name: '拉取最新代码', cmd: 'git pull --ff-only', tolerant: true },
    { name: '安装依赖', cmd: 'pnpm install' },
    { name: '构建前端', cmd: 'pnpm --filter @supercrzy/client build' },
  ]

  try {
    for (const step of steps) {
      send(step.name, 'start')
      try {
        const { stdout, stderr } = await execAsync(step.cmd, {
          cwd: step.cwd || PROJECT_ROOT,
          timeout: 180000, // 3 分钟超时
          maxBuffer: 8 * 1024 * 1024,
        })
        const tail = (stdout + stderr).trim().split('\n').slice(-3).join('\n')
        send(step.name, tail || 'done', true)
      } catch (err: any) {
        const msg = err.message || ''
        // commit 无改动时 git 报错（nothing to commit）→ 不算失败，继续
        if (step.name === '提交当前改动' && (msg.includes('nothing to commit') || msg.includes('no changes'))) {
          send(step.name, '无待提交改动，跳过', true)
        }
        // 拉取失败（远程不存在/未配置/无网络）→ 降级：本地自更新继续
        else if (step.tolerant && (msg.includes('Repository not found') || msg.includes('Could not resolve host') || msg.includes('not a git repository') || msg.includes('no such remote'))) {
          send(step.name, `远程不可用，跳过拉取（${msg.split('\n')[0]?.slice(0, 80)}）`, true)
        } else {
          send(step.name, `失败: ${msg.slice(0, 300)}`, false)
          send('error', `更新中断于「${step.name}」`, false)
          endSseStream(ctx)
          return
        }
      }
    }
    send('done', '更新完成！请重启服务使新版本生效。', true)
  } catch (err: any) {
    send('error', `更新异常: ${err.message}`, false)
  } finally {
    endSseStream(ctx)
  }
})

/**
 * 运行健康诊断（仅 localhost）。
 *
 * 存在意义：08-27 那次"SSE 并发卡"的排查死在没有客观数字上——一头说卡了 2 分钟，一头说前台重测完全正常，
 * 结论反复。之后所有"卡不卡/稳不稳"的判断都应该先看这两个数字：
 *
 * - `eventLoop.verdict`：`blocked` 说明有同步调用把事件循环冻住（execSync/递归扫盘/大文件同步读），
 *   此时**所有**并发 SSE 都会停推——这才是后端真卡的形态。
 * - `sse.active`：当前活跃流数。eventLoop 正常 + 前端仍不动 → 问题在传输层/客户端（浏览器连接数上限、
 *   代理缓冲、主线程被渲染占满），别再翻后端。
 *
 * `?reset=1` 清零滚窗与计数（压测前调一次，保证读数属于本次压测）。
 */
systemRouter.get('/diagnostics', async (ctx: Context) => {
  if (!isLocalhost(ctx)) {
    ctx.status = 403
    ctx.body = { error: 'Forbidden' }
    return
  }
  if (ctx.query.reset === '1') {
    resetEventLoopStats()
    resetSseStats()
  }
  const eventLoop = getEventLoopStats()
  ctx.body = {
    eventLoop,
    sse: getSseStats(),
    process: {
      uptime_s: Math.round(process.uptime()),
      rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      pid: process.pid,
      node: process.version,
    },
    hint: eventLoop.verdict === 'blocked'
      ? '事件循环被同步调用冻住 >1s：并发 SSE 会整体停推。查 execSync / 递归 readdirSync / 大文件 readFileSync。'
      : eventLoop.verdict === 'busy'
        ? '存在百毫秒级同步阻塞，长任务并发时可能看到流抖动。'
        : '事件循环健康；若前端仍不推进，问题在传输层/客户端，不在后端。',
  }
})
