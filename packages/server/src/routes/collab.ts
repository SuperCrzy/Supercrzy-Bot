/**
 * 超级协作平台 API — 全新串行引擎（2026-09-01，替代幽灵并行）
 * 状态机：init→executing→reviewing→(senate)→delivering→done
 * 发布后用引擎自动串行推进 + 持久化，前端只轮询 getTask 即可看到各阶段进展。
 */
import Router from 'koa-router'
import type { Context } from 'koa'
import { createCollabTask, getCollabTask, listCollabTasks, stopCollabTask, decideCollabTask, promoteCollabTask } from '../services/collab-engine'
import { browserSession, browserKey, closeBrowserForSession, activeBrowserKeys, browserMode, attachEndpoint, getAttachReport, browserStartPageUrl, browserSessionPages } from '../services/ai-browser'
import { createAuditTask, getAuditTask, listAuditTasks } from '../services/collab-audit'

export const collabRouter = new Router({ prefix: '/api/collab' })

/**
 * 按请求解析浏览器实例 key(网页各会话隔离): 优先 X-Browser-Key / body.sessionId / query.sid
 * 2026-09-23：改走 browserKey() 唯一构造入口 —— 此前这里拼 'wb:' 而 AI 工具侧硬编码 'default'，
 * 两套命名空间不相交，右栏永远看不到 AI 的动作画面。
 */
function browserKeyOf(ctx: Context): string {
  const h = ctx.get?.('x-browser-key') || ''
  if (h) return browserKey(h)
  const b = (ctx.request.body || {}) as { sessionId?: string }
  const q = ctx.query as { sid?: string }
  return browserKey(b.sessionId || q.sid || 'default')
}
function bs(ctx: Context) { return browserSession(browserKeyOf(ctx)) }


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

// ---- AI 浏览器（按会话隔离 BrowserPlaywright 池，2026-09-04）----
// POST /api/collab/browser/navigate { url, sessionId? } / header x-browser-key → 单会话实例导航
collabRouter.post('/browser/navigate', async (ctx: Context) => {
  const url = String((ctx.request.body as { url?: string })?.url || '').trim()
  const sessionId = (ctx.request.body as { sessionId?: string })?.sessionId
  if (!url) { ctx.status = 400; ctx.body = { error: 'url is required' }; return }
  try { ctx.body = await bs(ctx).navigate(url) } catch (e: any) { ctx.status = 500; ctx.body = { error: e?.message || String(e) } }
  void sessionId
})

collabRouter.post('/browser/refresh', async (ctx: Context) => {
  try { ctx.body = await bs(ctx).refresh() } catch (e: any) { ctx.status = 500; ctx.body = { error: e?.message || String(e) } }
})

collabRouter.get('/browser/snapshot', async (ctx: Context) => {
  try { ctx.body = await bs(ctx).screenshot() } catch (e: any) { ctx.status = 500; ctx.body = { error: e?.message || String(e) } }
})

// GET /api/collab/browser/latest?after=<ts>&sid=… → 该会话长轮询: 有新帧即回,否则~12s回当前
collabRouter.get('/browser/latest', async (ctx: Context) => {
  try {
    const after = Number((ctx.query as any).after) || 0
    const f = await bs(ctx).waitAfter(after)
    ctx.body = f || { ts: 0, screenshot: '', url: '' }
  } catch (e: any) { ctx.status = 500; ctx.body = { error: e?.message || String(e) } }
})

// POST /api/collab/browser/close → 释放该会话浏览器实例（browserKey 幂等，直接传全量 key 即可）
collabRouter.post('/browser/close', async (ctx: Context) => {
  await closeBrowserForSession(browserKeyOf(ctx)); ctx.body = { closed: true }
})

// GET /api/collab/browser/sessions → 当前持有浏览器实例的 key（排查"任务跑完 Chrome 不退"用）
// 2026-09-23 增补 mode / attach：attach 模式下"接错了哪一页"是最难查的一类故障，
// 把决策过程（候选、跳过原因、最终选中）直接摊开，省掉一轮猜。
collabRouter.get('/browser/sessions', (ctx: Context) => {
  const mode = browserMode()
  ctx.body = {
    keys: activeBrowserKeys(),
    count: activeBrowserKeys().length,
    mode,
    endpoint: mode === 'attach' ? attachEndpoint() : null,
    // desktop 侧的原生视图要 loadURL 的地址。必须由后端给（而不是 desktop 自己拼），
    // 否则「起始页路径」和「宿主排除规则」两处会各写一份、悄悄漂开。
    startPageUrl: mode === 'attach' ? browserStartPageUrl() : null,
    // 每个活会话**此刻**在哪一页（区别于 attach.adopted 的"最后一次采纳决策"——
    // 视图导航后 adopted 不会更新，只看它会得到会说谎的诊断）
    pages: browserSessionPages(),
    attach: mode === 'attach' ? getAttachReport() : null,
  }
})

// ---- AI 浏览器动作层 L2 (经单会话实例: 人点画面/AI动统一) ----
// POST /api/collab/browser/act { action, x?, y?, text?, into?, key?, deltaY?, sessionId? }
collabRouter.post('/browser/act', async (ctx: Context) => {
  const b = ctx.request.body as { action?: string; x?: number; y?: number; text?: string; into?: string; key?: string; deltaY?: number }
  const a = b.action || ''
  try {
    const h = bs(ctx)
    let out: any
    if (a === 'click_at' && typeof b.x === 'number' && typeof b.y === 'number') out = await h.clickAt(b.x, b.y)
    else if (a === 'click_text') out = await h.clickText(String(b.text || ''))
    else if (a === 'type') out = await h.typeText(String(b.text || ''), b.into ? String(b.into) : undefined)
    else if (a === 'key') out = await h.press(String(b.key || ''))
    else if (a === 'scroll') out = await h.wheel(Number(b.deltaY) || 300)
    else if (a === 'back') out = await h.goBack()
    else return ctx.status = 400, ctx.body = { error: `未知 action: ${a}` }
    const snap = await h.screenshot().catch(() => null) // 动作后补帧→长轮询即时呈现
    ctx.body = { result: out, snapshot: snap }
  } catch (e: any) { ctx.status = 500; ctx.body = { error: e?.message || String(e) } }
})

// GET /api/collab/browser/interactive → 该会话当前页可交互元素(LLM/人参考)
collabRouter.get('/browser/interactive', async (ctx: Context) => {
  try { ctx.body = { items: await bs(ctx).interactive() } } catch (e: any) { ctx.status = 500; ctx.body = { error: e?.message || String(e) } }
})

export default collabRouter
