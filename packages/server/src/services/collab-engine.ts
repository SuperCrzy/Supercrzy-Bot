/**
 * 超级协作平台 — 全新串行引擎（2026-09-01，替代幽灵并行）
 *
 * 状态机（半自动=人控，全自动=自治，同一引擎不同档位）：
 *   init → executing → reviewing → (senate模式加) senate → delivering → done
 *                              └── 各阶段失败 → failed（带 error 卡因）
 *
 * 承诺：
 *  - 串行：前一个阶段完成才进入下一个，严格阶段次序，非并行分解
 *  - 持久化：collab_tasks 表，每阶段进度落库，进程/重启不丢（列表可恢复）
 *  - 多品牌：执行=DeepSeek，质检=Kimi，议院=DeepSeek+Kimi+GPT(配 key 才上，缺则 DeepSeek 补)
 *  - 卡因诊断：复用 buildApiError/classifyApiError 语义，超时/欠费/连不上 分流
 */
import { randomUUID } from 'crypto'
import { getDB } from './database'
import { getProviderConfig, chatWithProvider } from './llm-config'
import { runQualityReview } from './collab-quality'
import { runSenateReview } from './collab-senate'

// ---- 类型 ----
export type CollabState = 'init' | 'executing' | 'reviewing' | 'senate' | 'optimizing' | 'delivering' | 'done' | 'failed'
export type CollabMode = 'semi' | 'senate'

export interface CollabTask {
  id: string
  sessionId?: string
  goal: string
  mode: CollabMode
  state: CollabState
  stage: string          // 当前/最后阶段
  delivery: string       // 最终交付物
  quality?: any
  senate?: any
  round: number          // 收敛轮次
  history: Array<{ stage: string; at: number; actor: string; summary: string }>
  error?: string
  createdAt: string
  updatedAt: string
}

// 执行贡献者：执行AI=DeepSeek，质检AI=Kimi（真多厂商对证）
const EXECUTOR_PROVIDER = 'deepseek'
const REVIEWER_PROVIDER = 'kimi'
// 议院（含多个品牌；缺 key 的 provider 会被 chatWithProvider 跳过，用 DeepSeek 补足）
const SENATE_PROVIDERS = ['deepseek', 'kimi']

// ---- 持久化 ----
const STAGE_TIMEOUT_MS = 90000   // 阶段超时熔断
// 收敛闭环（2026-09-01）：质检/议院打回 → 执行重做，最多 MAX_CONVERGE_ROUNDS 轮
const MAX_CONVERGE_ROUNDS = 2
const QUALITY_PASS_THRESHOLD = 70   // 质检分低于此则触发打回重做

function rowToTask(r: any): CollabTask {
  return {
    id: r.id, sessionId: r.session_id, goal: r.goal, mode: r.mode,
    state: r.state, stage: r.stage, delivery: r.delivery,
    quality: JSON.parse(r.quality || '{}'), senate: JSON.parse(r.senate || '{}'),
    round: r.round, history: JSON.parse(r.history || '[]'), error: r.error,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

function persist(t: CollabTask) {
  const db = getDB()
  db.prepare(`UPDATE collab_tasks SET state=?, stage=?, delivery=?, quality=?, senate=?, round=?, history=?, error=?, updated_at=datetime('now') WHERE id=?`).run(
    t.state, t.stage, t.delivery, JSON.stringify(t.quality || {}), JSON.stringify(t.senate || {}),
    t.round, JSON.stringify(t.history), t.error || '', t.id,
  )
}

function pushStage(t: CollabTask, actor: string, summary: string) {
  t.history.push({ stage: t.stage, at: Date.now(), actor, summary })
  if (t.history.length > 50) t.history = t.history.slice(-50)
  persist(t)
}

export function getCollabTask(id: string): CollabTask | null {
  const r = getDB().prepare('SELECT * FROM collab_tasks WHERE id = ?').get(id) as any
  return r ? rowToTask(r) : null
}

export function listCollabTasks(): CollabTask[] {
  const rows = getDB().prepare('SELECT * FROM collab_tasks ORDER BY created_at DESC').all() as any[]
  return rows.map(rowToTask)
}

// ---- 状态机推进 ----

async function timeout(ms: number) {
  return new Promise((res) => setTimeout(res, ms))
}

/** 带超时的执行：任一阶段卡住(超时) → 熔断进 failed，卡因=timeout */
async function withTimeout<T>(fn: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; reason: 'timeout' | 'error'; error?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutP = new Promise<{ ok: false; reason: 'timeout' }>((res) => {
    timer = setTimeout(() => res({ ok: false, reason: 'timeout' }), ms)
  })
  try {
    const v = (await Promise.race([fn, timeoutP])) as T | { ok: false; reason: 'timeout' }
    clearTimeout(timer!)
    if (v && typeof v === 'object' && 'ok' in v && (v as any).ok === false) {
      return v as { ok: false; reason: 'timeout' }
    }
    return { ok: true, value: v as T }
  } catch (e: any) {
    clearTimeout(timer!)
    return { ok: false, reason: 'error', error: e?.message || String(e) }
  }
}

const EXECUTOR_SYSTEM = '你是超级协作平台的执行AI。直接完成用户任务并输出交付物正文，不要输出思考过程、不要"我完成了"这类废话。只输出结果本身。（Markdown 可用）'

async function runExecuting(t: CollabTask) {
  t.state = 'executing'; t.stage = 'executing'; persist(t)
  const r = await withTimeout(
    chatWithProvider(EXECUTOR_PROVIDER, [
      { role: 'system', content: EXECUTOR_SYSTEM },
      { role: 'user', content: t.goal },
    ], { maxTokens: 3000, temperature: 0.3 }),
    STAGE_TIMEOUT_MS,
  )
  if (!r.ok) { t.state = 'failed'; t.error = r.reason === 'timeout' ? '执行超时' : r.error; t.stage = 'executing'; persist(t); return }
  t.delivery = r.value
  pushStage(t, '执行AI', '已完成任务交付')
  // 进入质检阶段
  await runReviewing(t)
}

async function runReviewing(t: CollabTask) {
  t.state = 'reviewing'; t.stage = 'reviewing'; persist(t)
  const r = await withTimeout(
    runQualityReview(t.goal, t.delivery, t.id).then((q) => q),
    STAGE_TIMEOUT_MS,
  )
  if (!r.ok) { t.state = 'failed'; t.error = r.reason === 'timeout' ? '质检超时' : r.error; t.stage = 'reviewing'; persist(t); return }
  t.quality = r.value
  pushStage(t, '质检AI', `质检评分 ${t.quality.score ?? '?'}，问题 ${(t.quality.issues || []).length} 条`)
  // 收敛闭环：质检分低于阈值且未超轮次 → 打回执行重做（半自动=人控前自动收敛；议院交给 senate 综合）
  if (t.round < MAX_CONVERGE_ROUNDS && (t.quality.score ?? 100) < QUALITY_PASS_THRESHOLD) {
    await runOptimizing(t, '质检')
    return
  }
  // 议院模式才进 senate，否则交付
  if (t.mode === 'senate') { await runSenate(t) } else { await runDelivering(t) }
}

async function runSenate(t: CollabTask) {
  t.state = 'senate'; t.stage = 'senate'; persist(t)
  const r = await withTimeout(
    runSenateReview(t.goal, t.delivery, t.id),
    STAGE_TIMEOUT_MS,
  )
  if (!r.ok) { t.state = 'failed'; t.error = r.reason === 'timeout' ? '议院评审超时' : r.error; t.stage = 'senate'; persist(t); return }
  t.senate = r.value
  const pass = (t.senate as any).passCount ?? 0, total = (t.senate as any).totalSenators ?? 0
  const reject = (t.senate as any).rejectCount ?? 0
  pushStage(t, '议院', `通过 ${pass}/${total}${reject > 0 ? '，有打回建议' : ''}`)
  // 收敛闭环：议院有打回建议且未超轮次 → 打回执行重做
  if (t.round < MAX_CONVERGE_ROUNDS && reject > 0) {
    await runOptimizing(t, '议院')
    return
  }
  await runDelivering(t)
}

/** 收敛：把质检/议院问题反馈给执行AI重做，重新质检 */
async function runOptimizing(t: CollabTask, by: string) {
  t.state = 'optimizing'; t.stage = 'optimizing'; t.round++  // 收敛轮次递增
  persist(t)
  // 组织反馈问题（来自质检/议院 issues）
  const src = by === '议院' ? t.senate : t.quality
  const issues = (src?.issues || []).slice(0, 5).map((i: any) => `- [${i.severity}] ${i.dimension}: ${i.title}`).join('\n') || '（无具体问题，请自查完善）'
  const prompt = `你上次的交付如下：\n\n${t.delivery}\n\n${by}AI 提出以下问题需你修改优化（第 ${t.round} 轮）：\n${issues}\n\n请基于这些问题重新产出完善后的交付物正文（只输出最终结果）。`
  const r = await withTimeout(
    chatWithProvider(EXECUTOR_PROVIDER, [
      { role: 'system', content: EXECUTOR_SYSTEM },
      { role: 'user', content: prompt },
    ], { maxTokens: 3000, temperature: 0.3 }),
    STAGE_TIMEOUT_MS,
  )
  if (!r.ok || !r.value) {
    // 重做失败推进交付（保底，不无限循环）
    pushStage(t, '执行AI', `${by}建议打回但重做失败，保留原交付`)
    await runDelivering(t); return
  }
  t.delivery = r.value
  pushStage(t, '执行AI', `${by}建议已采纳，已完成第 ${t.round} 轮优化`)
  // 重做后再质检（进入新一轮收敛）
  await runReviewing(t)
}

async function runDelivering(t: CollabTask) {
  t.state = 'delivering'; t.stage = 'delivering'; persist(t)
  pushStage(t, '平台', '已收敛交付')
  t.state = 'done'; t.stage = 'done'; persist(t)
}

/** 启动一条串行任务流水线（异步跑，不阻塞发布接口） */
export async function startCollabTask(t: CollabTask) {
  try { await runExecuting(t) }
  catch (e: any) {
    t.state = 'failed'; t.error = e?.message || String(e); persist(t)
  }
}

/** 创建任务：落库 + 异步启动串行流水线 */
export async function createCollabTask(goal: string, mode: CollabMode, sessionId?: string): Promise<CollabTask> {
  const t: CollabTask = {
    id: `ct_${Date.now()}_${randomUUID().slice(0, 6)}`,
    sessionId, goal, mode,
    state: 'init', stage: 'init', delivery: '',
    round: 0, history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }
  getDB().prepare('INSERT INTO collab_tasks (id, session_id, goal, mode, state, stage) VALUES (?, ?, ?, ?, ?, ?)').run(
    t.id, sessionId || null, goal, mode, 'init', 'init',
  )
  // 异步推进（不 await，发布接口立即返回）
  void startCollabTask(t)
  return t
}

/** 停止/标记（保留任务，停止推进） */
export function stopCollabTask(id: string): boolean {
  const t = getCollabTask(id)
  if (!t) return false
  // 无运行中取消句柄，标记状态用失败包裹（前端据此显示"已停止"）
  if (t.state === 'init' || t.state === 'executing' || t.state === 'reviewing' || t.state === 'senate') {
    t.state = 'failed'; t.stage = 'stopped'; t.error = 'user_stopped'; persist(t)
  }
  return true
}

// 重启时把未完成的 executing/reviewing/senate 标记为 failed（进程中断恢复提示）
export function recoverInterruptedTasks() {
  const db = getDB()
  db.prepare(`UPDATE collab_tasks SET state='failed', stage='interrupted', error='进程重启导致执行中断，请重新发布' WHERE state IN ('init','executing','reviewing','senate')`).run()
}
