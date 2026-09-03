/**
 * 超级协作平台 API — 全新串行引擎（2026-09-01，替代幽灵并行）
 * 状态机：init→executing→reviewing→(senate)→delivering→done
 * 发布后用引擎自动串行推进 + 持久化，前端只轮询 getTask 即可看到各阶段进展。
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { createCollabTask, getCollabTask, listCollabTasks, stopCollabTask, decideCollabTask, promoteCollabTask } from '../services/collab-engine'
import { browserNavigate, browserRefresh, browserScreenshot, closeBrowser,
  browserClickAt, browserClickText, browserTypeText, browserPressKey, browserScroll, browserBack, browserListInteractive } from '../services/ai-browser'
import { createAuditTask, getAuditTask, listAuditTasks } from '../services/collab-audit'

export const collabRouter = new Router({ prefix: '/api/collab' })

/**
 * POST /api/collab/tasks — 发布协作任务
 * body: { goal, mode?: 'semi'|'senate', sessionId? }
 *   semi=半自动(执行→质检，你主导)；senate=全自动议院(执行→质检→议院，AI自治)
 */
collabRouter.post('/tasks', async (ctx: Context) => {
  const body = ctx.request.body as { goal?: string; mode?: string; sessionId?: string }
  const goal = String(body.goal || '').trim()
  if (!goal) { ctx.status = 400; ctx.body = { error: 'goal is required' }; return }

  const mode = body.mode === 'senate' ? 'senate' : 'semi'
  const task = await createCollabTask(goal, mode, body.sessionId)
  ctx.status = 202
  ctx.body = { taskId: task.id, status: task.state, mode }
})

// 任务列表（持久化，重启不丢）
collabRouter.get('/tasks', (ctx: Context) => {
  ctx.body = listCollabTasks().map((t) => ({
    taskId: t.id, goal: t.goal, status: t.state === 'failed' ? 'failed' : t.state,
    state: t.state, stage: t.stage, mode: t.mode, round: t.round,
    createdAt: Date.parse(t.createdAt), ghosts: [],
    summary: t.state === 'done' ? t.delivery : '',
    delivery: t.delivery, quality: t.quality, senate: t.senate, history: t.history,
    suggestSenate: t.suggestSenate || 0,
    error: t.error || undefined,
  }))
})

// 单任务详情（完整：含 delivery/quality/senate/history）
collabRouter.get('/tasks/:id', (ctx: Context) => {
  const t = getCollabTask(ctx.params.id)
  if (!t) { ctx.status = 404; ctx.body = { error: 'task not found' }; return }
  ctx.body = {
    taskId: t.id, goal: t.goal, status: t.state === 'failed' ? 'failed' : t.state,
    state: t.state, stage: t.stage, mode: t.mode, round: t.round,
    createdAt: Date.parse(t.createdAt),
    summary: t.state === 'done' ? t.delivery : '',
    quality: t.quality, senate: t.senate, history: t.history,
    suggestSenate: t.suggestSenate || 0,
    error: t.error || undefined,
  }
})

// 机制C：半自动 done 后用户同意升议院评审
collabRouter.post('/tasks/:id/promote', async (ctx: Context) => {
  const t = await promoteCollabTask(ctx.params.id)
  if (!t) { ctx.status = 404; ctx.body = { error: 'task not found or not deliverable' }; return }
  ctx.body = { taskId: t.id, state: t.state, stage: t.stage }
})

// 停止任务
collabRouter.post('/tasks/:id/stop', (ctx: Context) => { ctx.body = { stopped: stopCollabTask(ctx.params.id) } })

// 半自动人控裁定：awaiting_decision 时用户 通过/打回/放弃
collabRouter.post('/tasks/:id/decision', async (ctx: Context) => {
  const { decision, feedback } = ctx.request.body as { decision?: string; feedback?: string }
  if (!decision || !['accept', 'revise', 'discard'].includes(decision)) {
    ctx.status = 400; ctx.body = { error: 'decision must be accept|revise|discard' }; return
  }
  const t = await decideCollabTask(ctx.params.id, decision as any, feedback)
  if (!t) { ctx.status = 404; ctx.body = { error: 'task not found or not awaiting decision' }; return }
  ctx.body = { taskId: t.id, state: t.state, stage: t.stage, round: t.round }
})

// ---- 全自动众议院 · 项目会诊（2026-09-01 异步任务版，避免同步超时）----
// POST /api/collab/audit { path, instruction? } → 发布会诊，立即返回 taskId，后台跑
collabRouter.post('/audit', async (ctx: Context) => {
  const body = ctx.request.body as { path?: string; instruction?: string }
  const projectPath = String(body.path || '').trim()
  if (!projectPath) { ctx.status = 400; ctx.body = { error: 'path is required' }; return }
  const task = createAuditTask(projectPath, body.instruction)
  ctx.status = 202
  ctx.body = { taskId: task.id, status: task.status, project: task.project }
})

// GET /api/collab/audit → 会诊任务列表
collabRouter.get('/audit', (ctx: Context) => { ctx.body = listAuditTasks() })

// GET /api/collab/audit/:id → 会诊任务详情（含进度/结果）
collabRouter.get('/audit/:id', (ctx: Context) => {
  const t = getAuditTask(ctx.params.id)
  if (!t) { ctx.status = 404; ctx.body = { error: 'audit not found' }; return }
  ctx.body = t
})

// ---- AI 浏览器（Playwright 实接，2026-09-01）----
// POST /api/collab/browser/navigate { url } → 导航并返回截图(base64)
collabRouter.post('/browser/navigate', async (ctx: Context) => {
  const url = String((ctx.request.body as { url?: string })?.url || '').trim()
  if (!url) { ctx.status = 400; ctx.body = { error: 'url is required' }; return }
  try {
    ctx.body = await browserNavigate(url)
  } catch (e: any) {
    ctx.status = 500; ctx.body = { error: e?.message || String(e) }
  }
})

// POST /api/collab/browser/refresh → 刷新当前页并截图
collabRouter.post('/browser/refresh', async (ctx: Context) => {
  try { ctx.body = await browserRefresh() } catch (e: any) { ctx.status = 500; ctx.body = { error: e?.message || String(e) } }
})

// GET /api/collab/browser/snapshot → 当前页截图（无导航）
collabRouter.get('/browser/snapshot', async (ctx: Context) => {
  try { ctx.body = await browserScreenshot() } catch (e: any) { ctx.status = 500; ctx.body = { error: e?.message || String(e) } }
})

// GET /api/collab/browser/latest → 最近一次动作后的画面帧(AI 驾驶时右栏自动轮询看实时)
collabRouter.get('/browser/latest', async (ctx: Context) => {
  try {
    const { getLastBrowserFrame } = await import('../services/ai-browser')
    const f = getLastBrowserFrame()
    ctx.body = f || { ts: 0, screenshot: '', url: '' }
  } catch (e: any) { ctx.status = 500; ctx.body = { error: e?.message || String(e) } }
})

// POST /api/collab/browser/close → 关闭浏览器实例
collabRouter.post('/browser/close', async (ctx: Context) => {
  await closeBrowser(); ctx.body = { closed: true }
})

// ---- AI 浏览器动作层 L2（2026-09-03 双向操作：人点画面/AI动同一页）----
// POST /api/collab/browser/act { action, x?, y?, text?, into?, key?, deltaY? }
collabRouter.post('/browser/act', async (ctx: Context) => {
  const b = ctx.request.body as { action?: string; x?: number; y?: number; text?: string; into?: string; key?: string; deltaY?: number }
  const a = b.action || ''
  try {
    let out: any
    if (a === 'click_at' && typeof b.x === 'number' && typeof b.y === 'number') out = await browserClickAt(b.x, b.y)
    else if (a === 'click_text') out = await browserClickText(String(b.text || ''))
    else if (a === 'type') out = await browserTypeText(String(b.text || ''), b.into ? String(b.into) : undefined)
    else if (a === 'key') out = await browserPressKey(String(b.key || ''))
    else if (a === 'scroll') out = await browserScroll(Number(b.deltaY) || 300)
    else if (a === 'back') out = await browserBack()
    else return ctx.status = 400, ctx.body = { error: `未知 action: ${a}` }
    const snap = out?.url ? await browserScreenshot().catch(() => null) : null
    ctx.body = { result: out, snapshot: snap }
  } catch (e: any) {
    ctx.status = 500; ctx.body = { error: e?.message || String(e) }
  }
})

// GET /api/collab/browser/interactive → 当前页可交互元素清单(LLM/人参考)
collabRouter.get('/browser/interactive', async (ctx: Context) => {
  try { ctx.body = { items: await browserListInteractive() } } catch (e: any) { ctx.status = 500; ctx.body = { error: e?.message || String(e) } }
})

export default collabRouter
