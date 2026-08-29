/**
 * 超级协作平台 API — 复用幽灵引擎（多 agent 并行分解执行），
 * 按协作平台语义暴露：半自动/议院模式、发言人 actor、授权秒数。
 * 前端通过 /api/collab/* 与 /ws/collab 调用（ghost 的 /ws/ghost 看板通道可复用）。
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { randomUUID } from 'crypto'
import { runGhostTask, stopGhostTask, listGhostTasks, getGhostTask } from '../services/ghost-engine'
import { runQualityReview, type QualityReport } from '../services/collab-quality'
import { runSenateReview, type SenateReport } from '../services/collab-senate'

export const collabRouter = new Router({ prefix: '/api/collab' })

// 任务模式注册表（taskId → senate/semi），供 quality/senate 端点分流
const taskMode = new Map<string, string>()

/**
 * POST /api/collab/tasks — 发布协作任务
 * body: { goal, mode?: 'semi'|'senate', actors?: string[], authSeconds?: number }
 *   mode: semi=半自动(1-2 AI) / senate=议院(多 AI 审查) —— 半自动=执行+质检，议院=执行+多把关
 *   authSeconds: 授权超时秒数（0=手动确认），默认 5（半自动）或 10（议院）
 */
collabRouter.post('/tasks', async (ctx: Context) => {
  const body = ctx.request.body as { goal?: string; mode?: string; authSeconds?: number; workspace?: string }
  const goal = String(body.goal || '').trim()
  if (!goal) { ctx.status = 400; ctx.body = { error: 'goal is required' }; return }

  const taskId = `ct_${Date.now()}_${randomUUID().slice(0, 6)}`
  const mode = body.mode === 'senate' ? 'senate' : 'semi'
  taskMode.set(taskId, mode)  // 记录模式（供 quality/senate 端点分流）
  const concurrency = mode === 'senate' ? 4 : 2  // 议院更多把关 AI，半自动 2 个
  ctx.status = 202
  ctx.body = { taskId, status: 'decomposing', mode, authSeconds: body.authSeconds ?? (mode === 'senate' ? 10 : 5) }

  runGhostTask({
    taskId,
    goal,
    workspace: body.workspace || process.env.WORKSPACE_ROOT || process.cwd(),
    concurrency,
    permissionLevel: 'sandbox',
  }).catch((e: any) => console.error('[Collab] run task failed:', e?.message))
})

// 任务列表（运行中 + 已完成，内存态；注意：与幽灵共用内存 Map，重启丢失）
collabRouter.get('/tasks', (ctx: Context) => { ctx.body = listGhostTasks() })

// 单任务详情
collabRouter.get('/tasks/:id', (ctx: Context) => {
  const t = getGhostTask(ctx.params.id)
  if (!t) { ctx.status = 404; ctx.body = { error: 'task not found' }; return }
  ctx.body = t
})

// 停止任务
collabRouter.post('/tasks/:id/stop', (ctx: Context) => { ctx.body = { stopped: stopGhostTask(ctx.params.id) } })

// ---- P2 分层质检 ----
// 内存态质检报告缓存（与 collab 任务同生命周期）
const qualityCache = new Map<string, QualityReport>()

/**
 * GET /api/collab/tasks/:id/quality — 获取/触发质检报告
 * 任务 done 后首次请求生成（L2 质检 Agent），缓存；非 done 返回待质检。
 */
collabRouter.get('/tasks/:id/quality', async (ctx: Context) => {
  const id = ctx.params.id as string
  const cached = qualityCache.get(id)
  if (cached) { ctx.body = mergedQuality(id, cached); return }

  const t = getGhostTask(id)
  if (!t) { ctx.status = 404; ctx.body = { error: 'task not found' }; return }
  if (t.status !== 'done') { ctx.body = { taskId: id, status: 'pending' as const }; return }

  // 触发生成质检（一次性；并发请求用 in-flight 防重复）
  const report = await runQualityReview(t.goal, t.summary || '', id)
  qualityCache.set(id, report)
  ctx.body = mergedQuality(id, report)
})

function mergedQuality(id: string, r: QualityReport) {
  const t = getGhostTask(id)
  return {
    ...r,
    taskStatus: t?.status || 'unknown',
    sources: {
      ghosts: t?.ghosts?.length || 0,
      summaryChars: (t?.summary || '').length || 0,
    },
  }
}

// ---- P4 议院审查 ----
const senateCache = new Map<string, SenateReport>()

/**
 * GET /api/collab/tasks/:id/senate — 议院审查（多名议员独立审+投票）
 * 议员一票 == pass/reject，失败==abstain（容错不阻塞）；过半数 pass 且无 high → pass。
 * 多议员 Parallel 跑，任一失败不影响整体（Promise.all 中 runSenator 内部已 catch 归 abstain）。
 */
collabRouter.get('/tasks/:id/senate', async (ctx: Context) => {
  const id = ctx.params.id as string
  const cached = senateCache.get(id)
  if (cached) { ctx.body = { ...cached, taskStatus: getGhostTask(id)?.status || 'unknown' }; return }

  const t = getGhostTask(id)
  if (!t) { ctx.status = 404; ctx.body = { error: 'task not found' }; return }
  if (t.status !== 'done') { ctx.body = { taskId: id, status: 'pending' as const }; return }

  const report = await runSenateReview(t.goal, t.summary || '', id)
  senateCache.set(id, report)
  ctx.body = { ...report, taskStatus: t.status }
})

export default collabRouter
