/**
 * 统一任务状态机（P0-03，2026-09-16）
 *
 * 背景：任务状态此前分散在 7 个地方——Agent loop / SSE 事件 / 前端 aiStatus /
 * 工具卡片 / Plan Capsule / Checkpoint / 协作平台 / 自动化任务。各自维护一份，
 * 于是"前端显示完成但后端还在跑""点了停止但工具继续""流断了不知道能否恢复"
 * 这类问题无法统一处理。
 *
 * 本模块提供唯一权威的任务状态源：
 *   created → planning → awaiting_approval → running
 *                                              ├── waiting_user
 *                                              ├── paused
 *                                              ├── failed
 *                                              ├── cancelled
 *                                              └── completed
 *
 * 统一记录 9 个字段（报告 P0-03 规定）：
 *   task_id / session_id / status / current_step / checkpoint_id
 *   cancel_requested_at / failure_code / started_at / completed_at
 *
 * 阶段二-②（2026-09-18）补齐「暂停/恢复」闭环：与 cancel 同款设计 ——
 * pause_requested_at 只打标记不改状态（UI 显示"正在暂停…"），
 * 真正落到 paused 由 agent loop 在轮次边界观察后完成；
 * 恢复复用既有 checkpoint 续跑通道，不另造一套。
 *
 * 设计原则：**只新增、不改写**。各子系统（agent loop / collab / automations）
 * 通过 mapXxx() 适配器把自己的本地状态投影到本状态机，不再各自向 UI 暴露状态。
 * 落库走独立表 task_runs，懒建表，失败不影响主流程。
 */
import { getDB } from './database'

// ==================== 状态定义 ====================

/** 规范状态（报告 P0-03 的 1:1 落地） */
export type TaskStatus =
  | 'created'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'waiting_user'
  | 'paused'
  | 'failed'
  | 'cancelled'
  | 'completed'

/** 终态：到达后不可再流转（除人工重开） */
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['failed', 'cancelled', 'completed']

/** 处于"仍在推进/可被打断"的状态 */
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['created', 'planning', 'awaiting_approval', 'running', 'waiting_user', 'paused']

/** 合法流转表（来自报告的状态树；同态更新与 → 终态 始终允许） */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  created: ['planning', 'running', 'awaiting_approval', 'waiting_user', 'paused', 'failed', 'cancelled', 'completed'],
  planning: ['awaiting_approval', 'running', 'waiting_user', 'paused', 'failed', 'cancelled', 'completed'],
  awaiting_approval: ['running', 'waiting_user', 'paused', 'failed', 'cancelled'],
  running: ['waiting_user', 'paused', 'failed', 'cancelled', 'completed'],
  waiting_user: ['running', 'paused', 'failed', 'cancelled', 'completed'],
  paused: ['running', 'failed', 'cancelled', 'completed'],
  failed: ['running', 'created'],
  cancelled: ['created'],
  completed: [],
}

/** 统一任务记录（报告规定的 9 字段 + 少量派生字段） */
export interface TaskRecord {
  task_id: string
  session_id: string
  status: TaskStatus
  current_step: string
  checkpoint_id: string
  cancel_requested_at: number | null
  /** 暂停请求时间戳（只打标记不改状态；null = 无暂停请求） */
  pause_requested_at: number | null
  failure_code: string | null
  started_at: number
  completed_at: number | null
  /** 派生：最近一次状态更新时间 */
  updated_at: number
  /** 派生：展示用标签（如"代码审计"） */
  label: string
  /** 派生：来源子系统 */
  source: TaskSource
  /** 派生：失败时的可读原因（failure_code 的人话版） */
  failure_message: string | null
  /** P2-02 任务级可观测：本任务累计 token / 成本(USD) / 耗时(ms) */
  tokens: number
  cost_usd: number
  duration_ms: number
}

export type TaskSource = 'agent' | 'collab' | 'automation' | 'routine' | 'unknown'

export interface CreateTaskInput {
  taskId?: string
  sessionId: string
  label?: string
  source?: TaskSource
  currentStep?: string
  checkpointId?: string
  status?: TaskStatus
}

// ==================== 内存注册表 ====================

const TASKS = new Map<string, TaskRecord>()
/** 按 session 反查（一个会话通常只有一个活跃任务） */
const BY_SESSION = new Map<string, string>()

let seq = 0
function nextId(prefix = 'task'): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`
}

// ==================== 落库（懒建表，失败静默降级） ====================

let tableReady = false

function ensureTable(): boolean {
  if (tableReady) return true
  try {
    const db = getDB()
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_runs (
        task_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        current_step TEXT DEFAULT '',
        checkpoint_id TEXT DEFAULT '',
        cancel_requested_at INTEGER,
        pause_requested_at INTEGER,
        failure_code TEXT,
        failure_message TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL,
        label TEXT DEFAULT '',
        source TEXT DEFAULT 'unknown',
        tokens INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        duration_ms INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_task_runs_session ON task_runs(session_id);
      CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
      CREATE INDEX IF NOT EXISTS idx_task_runs_updated ON task_runs(updated_at DESC);
    `)
    // P2-02：老库缺列时补列（SQLite 报 duplicate column 属预期，逐列 try）
    for (const col of ['tokens INTEGER DEFAULT 0', 'cost_usd REAL DEFAULT 0', 'duration_ms INTEGER DEFAULT 0', 'pause_requested_at INTEGER']) {
      try { db.exec(`ALTER TABLE task_runs ADD COLUMN ${col}`) } catch { /* 已存在 */ }
    }
    tableReady = true
    return true
  } catch {
    return false
  }
}

function persist(rec: TaskRecord): void {
  if (!ensureTable()) return
  try {
    getDB()
      .prepare(
        `INSERT INTO task_runs (task_id, session_id, status, current_step, checkpoint_id,
           cancel_requested_at, pause_requested_at, failure_code, failure_message, started_at, completed_at,
           updated_at, label, source, tokens, cost_usd, duration_ms)
         VALUES (@task_id, @session_id, @status, @current_step, @checkpoint_id,
           @cancel_requested_at, @pause_requested_at, @failure_code, @failure_message, @started_at, @completed_at,
           @updated_at, @label, @source, @tokens, @cost_usd, @duration_ms)
         ON CONFLICT(task_id) DO UPDATE SET
           status=excluded.status, current_step=excluded.current_step,
           checkpoint_id=excluded.checkpoint_id, cancel_requested_at=excluded.cancel_requested_at,
           pause_requested_at=excluded.pause_requested_at,
           failure_code=excluded.failure_code, failure_message=excluded.failure_message,
           completed_at=excluded.completed_at, updated_at=excluded.updated_at,
           label=excluded.label, tokens=excluded.tokens,
           cost_usd=excluded.cost_usd, duration_ms=excluded.duration_ms`,
      )
      .run(rec as any)
  } catch {
    /* 落库失败不影响运行中任务 */
  }
}

// ==================== 订阅（供 SSE 转发） ====================

type Listener = (rec: TaskRecord, prev: TaskStatus | null) => void
const LISTENERS = new Set<Listener>()

export function subscribeTaskState(fn: Listener): () => void {
  LISTENERS.add(fn)
  return () => LISTENERS.delete(fn)
}

function notify(rec: TaskRecord, prev: TaskStatus | null): void {
  for (const fn of LISTENERS) {
    try {
      fn(rec, prev)
    } catch {
      /* 单个监听器异常不影响其他 */
    }
  }
}

// ==================== 核心 API ====================

export function isTerminal(s: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(s)
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true
  if (isTerminal(to)) return true // 任何状态都可收敛到终态
  return (TRANSITIONS[from] || []).includes(to)
}

/** 创建任务（若该 session 已有活跃任务，先把它收敛为 cancelled，避免一个会话两条活跃记录） */
export function createTask(input: CreateTaskInput): TaskRecord {
  const sessionId = String(input.sessionId || '').trim()
  const existingId = sessionId ? BY_SESSION.get(sessionId) : undefined
  if (existingId) {
    const prev = TASKS.get(existingId)
    if (prev && !isTerminal(prev.status)) {
      applyStatus(prev, 'cancelled', { failureCode: 'superseded', failureMessage: '被新任务取代' })
    }
  }

  const now = Date.now()
  const rec: TaskRecord = {
    task_id: input.taskId || nextId(),
    session_id: sessionId,
    status: input.status || 'created',
    current_step: input.currentStep || '',
    checkpoint_id: input.checkpointId || '',
    cancel_requested_at: null,
    pause_requested_at: null,
    failure_code: null,
    failure_message: null,
    started_at: now,
    completed_at: isTerminal(input.status || 'created') ? now : null,
    updated_at: now,
    label: input.label || '',
    source: input.source || 'unknown',
    tokens: 0,
    cost_usd: 0,
    duration_ms: 0,
  }
  TASKS.set(rec.task_id, rec)
  if (sessionId) BY_SESSION.set(sessionId, rec.task_id)
  persist(rec)
  notify(rec, null)
  return rec
}

/** 内部：直接改状态并广播。返回是否真的变化。 */
function applyStatus(
  rec: TaskRecord,
  to: TaskStatus,
  opts: { step?: string; failureCode?: string; failureMessage?: string; checkpointId?: string } = {},
): boolean {
  const prev = rec.status
  if (opts.step !== undefined) rec.current_step = opts.step
  if (opts.checkpointId !== undefined) rec.checkpoint_id = opts.checkpointId
  if (to === 'failed') {
    rec.failure_code = opts.failureCode || 'unknown'
    rec.failure_message = opts.failureMessage || null
  } else if (opts.failureCode !== undefined) {
    rec.failure_code = opts.failureCode
    rec.failure_message = opts.failureMessage || null
  }
  rec.status = to
  rec.updated_at = Date.now()
  if (isTerminal(to) && !rec.completed_at) rec.completed_at = rec.updated_at
  persist(rec)
  if (prev !== to) notify(rec, prev)
  return prev !== to
}

/**
 * 流转状态。默认**强校验**：非法流转被拒绝并返回 false（避免"前端显示完成但后端还在跑"）。
 * 需要绕过时传 { force: true }（仅用于历史数据修复/适配器投影）。
 */
export function setTaskStatus(
  taskId: string,
  to: TaskStatus,
  opts: { step?: string; failureCode?: string; failureMessage?: string; checkpointId?: string; force?: boolean } = {},
): boolean {
  const rec = TASKS.get(taskId)
  if (!rec) return false
  if (opts.force) {
    applyStatus(rec, to, opts)
    return true
  }
  if (!canTransition(rec.status, to)) return false
  return applyStatus(rec, to, opts)
}

/** 更新当前步骤（不改变状态） */
export function setTaskStep(taskId: string, step: string): void {
  const rec = TASKS.get(taskId)
  if (!rec) return
  rec.current_step = step
  rec.updated_at = Date.now()
  persist(rec)
}

/** 记录检查点，便于"流断了能否恢复"有据可依 */
export function setTaskCheckpoint(taskId: string, checkpointId: string): void {
  const rec = TASKS.get(taskId)
  if (!rec) return
  rec.checkpoint_id = checkpointId
  rec.updated_at = Date.now()
  persist(rec)
}

/**
 * 请求取消：**只打标记，不改状态**。
 * 这正对应报告里的 cancel_requested_at —— 用户点了停止，但循环还在跑，
 * 此时状态仍是 running 且带取消标记，UI 显示"正在停止…"而不是"已停止"。
 */
export function requestTaskCancel(taskId: string): boolean {
  const rec = TASKS.get(taskId)
  if (!rec) return false
  if (isTerminal(rec.status)) return false
  rec.cancel_requested_at = Date.now()
  rec.updated_at = rec.cancel_requested_at
  persist(rec)
  notify(rec, rec.status)
  return true
}

/** 查询是否需要取消（agent loop 每轮调用） */
export function isCancelRequested(taskId: string): boolean {
  const rec = TASKS.get(taskId)
  return !!rec && !!rec.cancel_requested_at && !isTerminal(rec.status)
}

// ---------------- 暂停 / 恢复（阶段二-②） ----------------

/**
 * 请求暂停：**只打标记，不改状态** —— 与 requestTaskCancel 同款设计。
 * 语义差别：取消是终态（cancel_requested_at → cancelled），暂停不是终态
 * （pause_requested_at → paused，可 resume 回到 running）。
 * 取消优先：已请求取消的任务不再接受暂停请求。
 */
export function requestTaskPause(taskId: string): boolean {
  const rec = TASKS.get(taskId)
  if (!rec) return false
  if (isTerminal(rec.status)) return false
  if (rec.cancel_requested_at) return false // 取消优先，避免语义打架
  if (rec.status === 'paused') return true // 已暂停，幂等
  rec.pause_requested_at = Date.now()
  rec.updated_at = rec.pause_requested_at
  persist(rec)
  notify(rec, rec.status)
  return true
}

/** 查询是否需要暂停（agent loop 每轮调用） */
export function isPauseRequested(taskId: string): boolean {
  const rec = TASKS.get(taskId)
  return !!rec && !!rec.pause_requested_at && !isTerminal(rec.status) && rec.status !== 'paused'
}

export function isPaused(taskId: string): boolean {
  const rec = TASKS.get(taskId)
  return !!rec && rec.status === 'paused'
}

/** 清除暂停标记（loop 落 paused 后调用，避免下一轮又判定为需暂停） */
export function clearTaskPause(taskId: string): void {
  const rec = TASKS.get(taskId)
  if (!rec) return
  if (rec.pause_requested_at === null) return
  rec.pause_requested_at = null
  rec.updated_at = Date.now()
  persist(rec)
}

/**
 * 落到 paused（由 agent loop 在轮次边界调用，不是用户直接调）。
 * 保留 checkpoint_id，供 resume 复用既有续跑通道。
 */
export function pauseTask(taskId: string, opts: { step?: string; checkpointId?: string } = {}): boolean {
  const rec = TASKS.get(taskId)
  if (!rec) return false
  if (isTerminal(rec.status)) return false
  const ok = setTaskStatus(taskId, 'paused', { step: opts.step ?? '已暂停', checkpointId: opts.checkpointId })
  clearTaskPause(taskId)
  return ok
}

/**
 * 恢复：paused → running。**只改状态**，真正的续跑由既有 checkpoint 通道触发
 * （前端 resumeFromCheckpoint → sendAgentMessage(..., ckptId, ...)），不另造一套执行入口。
 */
export function resumeTask(taskId: string): boolean {
  const rec = TASKS.get(taskId)
  if (!rec) return false
  if (rec.status !== 'paused') return false
  if (rec.cancel_requested_at) return false // 已被取消，不允许恢复
  const ok = setTaskStatus(taskId, 'running', { step: '已恢复执行' })
  if (ok) clearTaskPause(taskId)
  return ok
}

export function completeTask(taskId: string, step = ''): boolean {
  return setTaskStatus(taskId, 'completed', { step, force: true })
}

export function failTask(taskId: string, failureCode: string, failureMessage?: string): boolean {
  return setTaskStatus(taskId, 'failed', { failureCode, failureMessage, force: true })
}

export function getTask(taskId: string): TaskRecord | null {
  return TASKS.get(taskId) || null
}

export function getTaskBySession(sessionId: string): TaskRecord | null {
  const id = BY_SESSION.get(sessionId)
  return id ? TASKS.get(id) || null : null
}

/** 当前所有活跃任务（内存视图） */
export function listActiveTasks(): TaskRecord[] {
  return [...TASKS.values()].filter((r) => !isTerminal(r.status)).sort((a, b) => b.updated_at - a.updated_at)
}

export function listTasks(limit = 100): TaskRecord[] {
  return [...TASKS.values()].sort((a, b) => b.updated_at - a.updated_at).slice(0, limit)
}

/** 从 DB 回填历史（进程重启后仍能看到上次的状态） */
export function restoreFromDB(limit = 200): number {
  if (!ensureTable()) return 0
  try {
    const rows = getDB()
      .prepare(`SELECT * FROM task_runs ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as TaskRecord[]
    let n = 0
    for (const r of rows) {
      if (!r || !r.task_id || TASKS.has(r.task_id)) continue
      // 进程重启后，落库为"进行中"的任务实际已中断 —— 收敛为 cancelled，避免幽灵任务
      if (!isTerminal(r.status)) {
        r.status = 'cancelled'
        r.failure_code = 'process_restarted'
        r.failure_message = '后端进程重启，任务已中断'
        r.completed_at = r.completed_at || r.updated_at
      }
      TASKS.set(r.task_id, r)
      if (r.session_id) BY_SESSION.set(r.session_id, r.task_id)
      n++
    }
    return n
  } catch {
    return 0
  }
}

/**
 * P2-02 任务级可观测：任务收尾时记录 token / 成本 / 耗时。
 * 与状态流转分开，因为这三项在任务跑完时才知道。
 */
export function recordTaskOutcome(
  taskId: string,
  outcome: { tokens?: number; costUsd?: number; durationMs?: number },
): boolean {
  const rec = TASKS.get(taskId)
  if (!rec) return false
  if (outcome.tokens !== undefined) rec.tokens = Math.max(0, Math.round(outcome.tokens))
  if (outcome.costUsd !== undefined) rec.cost_usd = Math.max(0, outcome.costUsd)
  if (outcome.durationMs !== undefined) rec.duration_ms = Math.max(0, Math.round(outcome.durationMs))
  rec.updated_at = Date.now()
  persist(rec)
  return true
}

export interface TaskStats {
  /** 任务总数（含历史回填） */
  total: number
  /** 各状态任务数 */
  byStatus: Record<string, number>
  /** 完成率（completed / total），0~1；无任务时为 0 */
  successRate: number
  /** 失败率（failed / total） */
  failureRate: number
  /** 取消率（cancelled / total） */
  cancelRate: number
  /** 累计 token */
  totalTokens: number
  /** 累计成本（USD） */
  totalCostUsd: number
  /** 平均任务耗时（ms，仅统计有耗时的任务） */
  avgDurationMs: number
  /** 实际生效的时间窗（天）；0 = 不限窗口（全量） */
  windowDays: number
  /** 窗口内的任务明细（按 updated_at 倒序），供用量页展开看单个任务 */
  tasks: TaskStatsRow[]
}

/** 任务明细行（用量页表格：只看决策需要的字段，不搬运整个 record） */
export interface TaskStatsRow {
  task_id: string
  session_id: string
  label: string
  source: TaskSource
  status: TaskStatus
  tokens: number
  cost_usd: number
  duration_ms: number
  started_at: number
  updated_at: number
  failure_message: string | null
}

export interface AggregateTaskStatsOptions {
  /** 只看最近 N 天（按 updated_at）；<=0 或未传 = 全量 */
  days?: number
  /** 明细最多返回多少行（默认 50，上限 500） */
  limit?: number
  /** 当前时间戳（测试注入用；默认 Date.now()） */
  now?: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_TASK_ROW_LIMIT = 50
const MAX_TASK_ROW_LIMIT = 500

/**
 * 任务级聚合统计（P2-02）。纯函数语义：只读内存注册表，便于单测。
 * 只统计非 created 态（即真正跑过的任务），避免把刚建的任务算进完成率分母。
 *
 * 2026-10-22（B4）：此前不看时间窗——路由把 ?days=N 原样回显，指标却是全量，
 * 页面上的「近 7 天」实际是全历史。现在按 updated_at 过滤，并把生效窗口回给调用方。
 */
export function aggregateTaskStats(opts: AggregateTaskStatsOptions = {}): TaskStats {
  const now = opts.now ?? Date.now()
  const rawDays = Number(opts.days ?? 0)
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), 365) : 0
  const since = days > 0 ? now - days * DAY_MS : null
  // 非正数/NaN 一律回落默认值：limit=-5 返回 1 行是调用方的意外，不是本函数的语义
  const rawLimit = Math.floor(Number(opts.limit) || 0)
  const limit = rawLimit > 0 ? Math.min(rawLimit, MAX_TASK_ROW_LIMIT) : DEFAULT_TASK_ROW_LIMIT

  const all = [...TASKS.values()].filter((r) => (since === null ? true : (r.updated_at || 0) >= since))
  const byStatus: Record<string, number> = {}
  let totalTokens = 0
  let totalCostUsd = 0
  let durationSum = 0
  let durationCount = 0

  for (const r of all) {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1
    totalTokens += r.tokens || 0
    totalCostUsd += r.cost_usd || 0
    if (r.duration_ms > 0) {
      durationSum += r.duration_ms
      durationCount++
    }
  }

  const total = all.length
  const rate = (n: number) => (total > 0 ? n / total : 0)
  const tasks: TaskStatsRow[] = all
    .slice()
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
    .slice(0, limit)
    .map((r) => ({
      task_id: r.task_id,
      session_id: r.session_id,
      label: r.label,
      source: r.source,
      status: r.status,
      tokens: r.tokens || 0,
      cost_usd: r.cost_usd || 0,
      duration_ms: r.duration_ms || 0,
      started_at: r.started_at || 0,
      updated_at: r.updated_at || 0,
      failure_message: r.failure_message ?? null,
    }))

  return {
    total,
    byStatus,
    successRate: rate(byStatus.completed || 0),
    failureRate: rate(byStatus.failed || 0),
    cancelRate: rate(byStatus.cancelled || 0),
    totalTokens,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
    windowDays: days,
    tasks,
  }
}

// ==================== 适配器：把各子系统本地状态投影到规范状态 ====================

/** 协作平台 CollabState → 规范状态 */
export function mapCollabState(s: string): TaskStatus {
  switch (s) {
    case 'init':
      return 'created'
    case 'executing':
    case 'optimizing':
    case 'delivering':
      return 'running'
    case 'reviewing':
    case 'senate':
      return 'running'
    case 'awaiting_decision':
      return 'waiting_user'
    case 'done':
      return 'completed'
    case 'failed':
      return 'failed'
    default:
      return 'running'
  }
}

/** 自动化/例行任务本地状态 → 规范状态 */
export function mapAutomationStatus(s: string): TaskStatus {
  switch (s) {
    case 'active':
    case 'pending':
    case 'scheduled':
      return 'created'
    case 'running':
      return 'running'
    case 'completed':
    case 'done':
    case 'success':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'stopped':
    case 'paused':
      return s === 'paused' ? 'paused' : 'cancelled'
    default:
      return 'running'
  }
}

/** Agent 收尾原因 → 规范状态（仅在 interrupted 非空时调用） */
export function mapAgentOutcome(reason: string): TaskStatus {
  switch (reason) {
    case 'completed':
    case 'done':
      return 'completed'
    case 'user_stopped':
      return 'cancelled'
    case 'user_paused':
      // 暂停不是终态：保留 checkpoint，可用既有续跑通道恢复
      return 'paused'
    default:
      // billing / auth / rate_limit / server_error / tool_sequence / turn_limit … 一律失败
      return 'failed'
  }
}

/** 状态 → 用户可读中文（前端也可用，但后端统一出人话） */
export function statusLabel(s: TaskStatus): string {
  const map: Record<TaskStatus, string> = {
    created: '已创建',
    planning: '规划中',
    awaiting_approval: '等待授权',
    running: '执行中',
    waiting_user: '等待你确认',
    paused: '已暂停',
    failed: '已失败',
    cancelled: '已取消',
    completed: '已完成',
  }
  return map[s] || s
}

/** 测试/清理用 */
export function __resetTaskState(): void {
  TASKS.clear()
  BY_SESSION.clear()
}
