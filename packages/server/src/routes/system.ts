/**
 * System API — 版本信息 + 一键更新
 * 仅允许 localhost 调用（防止远程滥用）
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { exec, execSync } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const PROJECT_ROOT = process.cwd()

export const systemRouter = new Router({ prefix: '/api/system' })

/** 仅 localhost 访问保护 */
function isLocalhost(ctx: Context): boolean {
  const ip = ctx.ip || ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')
}

/** 获取当前 git commit hash */
function getGitHead(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT }).toString().trim()
  } catch {
    return 'unknown'
  }
}

// 当前版本信息
systemRouter.get('/version', (ctx: Context) => {
  ctx.body = {
    version: process.env.APP_VERSION || '0.3.0',
    gitHead: getGitHead(),
    branch: (() => { try { return execSync('git branch --show-current', { cwd: PROJECT_ROOT }).toString().trim() } catch { return 'unknown' } })(),
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
  ctx.res.write(': connected\n\n')

  const send = (step: string, message: string, ok?: boolean) => {
    ctx.res.write(`data: ${JSON.stringify({ step, message, ok: ok ?? null })}\n\n`)
  }

  const steps: Array<{ name: string; cmd: string; cwd?: string }> = [
    { name: '提交当前改动', cmd: 'git add -A && git commit -m "chore: auto commit before update $(date +%Y%m%d-%H%M%S)" --no-verify' },
    { name: '拉取最新代码', cmd: 'git pull --ff-only' },
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
        // commit 无改动时 git 报错（nothing to commit）→ 不算失败，继续
        const msg = err.message || ''
        if (step.name === '提交当前改动' && (msg.includes('nothing to commit') || msg.includes('no changes'))) {
          send(step.name, '无待提交改动，跳过', true)
        } else {
          send(step.name, `失败: ${msg.slice(0, 300)}`, false)
          send('error', `更新中断于「${step.name}」`, false)
          ctx.res.end()
          return
        }
      }
    }
    send('done', '更新完成！请重启服务使新版本生效。', true)
  } catch (err: any) {
    send('error', `更新异常: ${err.message}`, false)
  } finally {
    ctx.res.end()
  }
})
