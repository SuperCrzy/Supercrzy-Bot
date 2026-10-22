/**
 * 统一任务状态机单测（P0-03）
 * 覆盖：流转合法性、终态收敛、取消标记语义、子系统状态适配。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createTask,
  setTaskStatus,
  setTaskStep,
  setTaskCheckpoint,
  requestTaskCancel,
  isCancelRequested,
  completeTask,
  failTask,
  getTask,
  getTaskBySession,
  listActiveTasks,
  canTransition,
  isTerminal,
  mapCollabState,
  mapAutomationStatus,
  mapAgentOutcome,
  statusLabel,
  recordTaskOutcome,
  aggregateTaskStats,
  __resetTaskState,
  type TaskStatus,
} from './task-state'

beforeEach(() => {
  __resetTaskState()
})

describe('状态流转合法性', () => {
  it('允许 created → planning → running → completed', () => {
    const t = createTask({ sessionId: 's1', status: 'created' })
    expect(setTaskStatus(t.task_id, 'planning')).toBe(true)
    expect(setTaskStatus(t.task_id, 'running')).toBe(true)
    expect(setTaskStatus(t.task_id, 'completed')).toBe(true)
    expect(getTask(t.task_id)!.status).toBe('completed')
  })

  it('拒绝非法流转（这是"前端显示完成但后端还在跑"的防线）', () => {
    const t = createTask({ sessionId: 's1', status: 'created' })
    setTaskStatus(t.task_id, 'planning')
    // planning 的合法去向只有 awaiting_approval/running/waiting_user/paused/终态，
    // 回退到 created 不在表内 → 必须被拒
    expect(setTaskStatus(t.task_id, 'created')).toBe(false)
    expect(getTask(t.task_id)!.status).toBe('planning')
  })

  it('任何状态都能收敛到终态', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    expect(canTransition('running', 'cancelled')).toBe(true)
    expect(canTransition('paused', 'failed')).toBe(true)
    expect(canTransition('awaiting_approval', 'completed')).toBe(true)
  })

  it('终态不可再流转（除人工重开）', () => {
    expect(isTerminal('completed')).toBe(true)
    expect(isTerminal('failed')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    expect(isTerminal('running')).toBe(false)
    const t = createTask({ sessionId: 's1', status: 'running' })
    completeTask(t.task_id)
    expect(setTaskStatus(t.task_id, 'running')).toBe(false)
  })

  it('force 可绕过校验（供历史修复用）', () => {
    const t = createTask({ sessionId: 's1', status: 'completed' })
    expect(setTaskStatus(t.task_id, 'running')).toBe(false)
    expect(setTaskStatus(t.task_id, 'running', { force: true })).toBe(true)
  })
})

describe('取消标记语义（cancel_requested_at）', () => {
  it('请求取消只打标记，不改状态——UI 显示"正在停止"而非"已停止"', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    expect(requestTaskCancel(t.task_id)).toBe(true)
    const rec = getTask(t.task_id)!
    expect(rec.status).toBe('running')       // 状态仍是 running
    expect(rec.cancel_requested_at).toBeGreaterThan(0)  // 但标记已置
    expect(isCancelRequested(t.task_id)).toBe(true)
  })

  it('已终态的任务不能再请求取消', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    completeTask(t.task_id)
    expect(requestTaskCancel(t.task_id)).toBe(false)
    expect(isCancelRequested(t.task_id)).toBe(false)
  })
})

describe('会话唯一性', () => {
  it('同一会话新建任务会把旧的活跃任务收敛为 cancelled，避免两条活跃记录', () => {
    const a = createTask({ sessionId: 'sess-x', status: 'running' })
    const b = createTask({ sessionId: 'sess-x', status: 'running' })
    const old = getTask(a.task_id)!
    expect(old.status).toBe('cancelled')
    expect(old.failure_code).toBe('superseded')
    expect(getTaskBySession('sess-x')!.task_id).toBe(b.task_id)
    expect(listActiveTasks().filter((r) => r.session_id === 'sess-x').length).toBe(1)
  })
})

describe('步骤与检查点', () => {
  it('记录 current_step 与 checkpoint_id，供"能否恢复"有据可依', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    setTaskStep(t.task_id, '执行工具：browser')
    setTaskCheckpoint(t.task_id, 'ckpt-123')
    const rec = getTask(t.task_id)!
    expect(rec.current_step).toBe('执行工具：browser')
    expect(rec.checkpoint_id).toBe('ckpt-123')
  })
})

describe('失败信息', () => {
  it('failTask 记录 failure_code 与人话原因', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    failTask(t.task_id, 'billing', '余额不足，请充值')
    const rec = getTask(t.task_id)!
    expect(rec.status).toBe('failed')
    expect(rec.failure_code).toBe('billing')
    expect(rec.failure_message).toBe('余额不足，请充值')
    expect(rec.completed_at).toBeGreaterThan(0)
  })
})

describe('子系统状态适配器', () => {
  it('collab 9 态 → 规范状态', () => {
    expect(mapCollabState('init')).toBe('created')
    expect(mapCollabState('executing')).toBe('running')
    expect(mapCollabState('awaiting_decision')).toBe('waiting_user')
    expect(mapCollabState('done')).toBe('completed')
    expect(mapCollabState('failed')).toBe('failed')
  })

  it('自动化状态 → 规范状态', () => {
    expect(mapAutomationStatus('active')).toBe('created')
    expect(mapAutomationStatus('running')).toBe('running')
    expect(mapAutomationStatus('completed')).toBe('completed')
    expect(mapAutomationStatus('error')).toBe('failed')
    expect(mapAutomationStatus('paused')).toBe('paused')
    expect(mapAutomationStatus('stopped')).toBe('cancelled')
  })

  it('agent 收尾原因 → 规范状态（非 user_stopped 一律 failed）', () => {
    expect(mapAgentOutcome('user_stopped')).toBe('cancelled')
    expect(mapAgentOutcome('billing')).toBe('failed')
    expect(mapAgentOutcome('rate_limit')).toBe('failed')
    expect(mapAgentOutcome('turn_limit')).toBe('failed')
    expect(mapAgentOutcome('completed')).toBe('completed')
  })

  it('状态都有中文标签', () => {
    const all: TaskStatus[] = ['created', 'planning', 'awaiting_approval', 'running', 'waiting_user', 'paused', 'failed', 'cancelled', 'completed']
    for (const s of all) expect(statusLabel(s)).not.toBe(s)
  })
})

describe('任务级可观测（P2-02）', () => {
  it('recordTaskOutcome 写入 token / 成本 / 耗时', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    expect(recordTaskOutcome(t.task_id, { tokens: 1234, costUsd: 0.0123, durationMs: 45000 })).toBe(true)
    const rec = getTask(t.task_id)!
    expect(rec.tokens).toBe(1234)
    expect(rec.cost_usd).toBeCloseTo(0.0123)
    expect(rec.duration_ms).toBe(45000)
  })

  it('负数被夹到 0，token 取整（脏数据不放宽统计）', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    recordTaskOutcome(t.task_id, { tokens: -5, costUsd: -1, durationMs: -100 })
    const rec = getTask(t.task_id)!
    expect(rec.tokens).toBe(0)
    expect(rec.cost_usd).toBe(0)
    expect(rec.duration_ms).toBe(0)
  })

  it('对不存在的任务返回 false，不抛错', () => {
    expect(recordTaskOutcome('no-such-task', { tokens: 1 })).toBe(false)
  })

  it('聚合：状态计数 / 完成率 / 失败率 / 取消率', () => {
    const a = createTask({ sessionId: 's1', status: 'running' })
    const b = createTask({ sessionId: 's2', status: 'running' })
    const c = createTask({ sessionId: 's3', status: 'running' })
    const d = createTask({ sessionId: 's4', status: 'running' })
    completeTask(a.task_id)
    completeTask(b.task_id)
    failTask(c.task_id, 'billing')
    requestTaskCancel(d.task_id)
    setTaskStatus(d.task_id, 'cancelled', { force: true })

    const st = aggregateTaskStats()
    expect(st.total).toBe(4)
    expect(st.byStatus.completed).toBe(2)
    expect(st.byStatus.failed).toBe(1)
    expect(st.byStatus.cancelled).toBe(1)
    expect(st.successRate).toBeCloseTo(0.5)
    expect(st.failureRate).toBeCloseTo(0.25)
    expect(st.cancelRate).toBeCloseTo(0.25)
  })

  it('聚合：累计 token / 成本 / 平均耗时（零耗时不进分母）', () => {
    const a = createTask({ sessionId: 's1', status: 'running' })
    const b = createTask({ sessionId: 's2', status: 'running' })
    recordTaskOutcome(a.task_id, { tokens: 100, costUsd: 0.01, durationMs: 10000 })
    recordTaskOutcome(b.task_id, { tokens: 300, costUsd: 0.03, durationMs: 30000 })
    const c = createTask({ sessionId: 's3', status: 'running' })  // 无耗时
    void c

    const st = aggregateTaskStats()
    expect(st.totalTokens).toBe(400)
    expect(st.totalCostUsd).toBeCloseTo(0.04)
    // 平均只算有耗时的 2 个任务 → (10000+30000)/2 = 20000
    expect(st.avgDurationMs).toBe(20000)
  })

  it('聚合：无任务时全为 0，不产生 NaN', () => {
    const st = aggregateTaskStats()
    expect(st.total).toBe(0)
    expect(st.successRate).toBe(0)
    expect(st.failureRate).toBe(0)
    expect(st.avgDurationMs).toBe(0)
    expect(st.totalTokens).toBe(0)
  })
})

/**
 * B4（2026-10-22）：任务统计此前接受 days 参数却不过滤，路由把 ?days=N 原样回显，
 * 于是页面上的「近 7 天」永远是全历史。这组测试钉住「窗口真生效」+「明细可下钻」。
 */
describe('任务统计的时间窗（B4）', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('days 未传 / 0 / 负数 / NaN ⇒ windowDays=0 且不过滤', () => {
    createTask({ sessionId: 's1', status: 'running' })
    for (const days of [undefined, 0, -3, Number.NaN]) {
      const st = aggregateTaskStats({ days: days as any })
      expect(st.windowDays, `days=${days} 应视为全量`).toBe(0)
      expect(st.total).toBe(1)
    }
  })

  it('days 超过 365 会被夹到 365（不许用超大窗口绕过过滤）', () => {
    expect(aggregateTaskStats({ days: 99999 }).windowDays).toBe(365)
  })

  it('🔴 窗口真生效：8 天前的任务在近 7 天窗口里不可见', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    const updatedAt = getTask(t.task_id)!.updated_at
    const st = aggregateTaskStats({ days: 7, now: updatedAt + 8 * DAY })
    expect(st.windowDays).toBe(7)
    expect(st.total, '8 天前更新的任务不该出现在近 7 天统计里').toBe(0)
    expect(st.tasks).toEqual([])
  })

  it('窗口边界：3 天前仍在近 7 天内可见', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    const updatedAt = getTask(t.task_id)!.updated_at
    const st = aggregateTaskStats({ days: 7, now: updatedAt + 3 * DAY })
    expect(st.total).toBe(1)
    expect(st.tasks[0].task_id).toBe(t.task_id)
  })

  it('全量口径下同一任务仍可见（过滤只由 days 决定）', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    const updatedAt = getTask(t.task_id)!.updated_at
    expect(aggregateTaskStats({ now: updatedAt + 400 * DAY }).total).toBe(1)
  })

  it('指标跟着窗口走，不是"窗口外的也照算"', () => {
    const a = createTask({ sessionId: 's1', status: 'running' })
    recordTaskOutcome(a.task_id, { tokens: 100, costUsd: 0.01, durationMs: 5000 })
    completeTask(a.task_id)
    const updatedAt = getTask(a.task_id)!.updated_at

    const inWindow = aggregateTaskStats({ days: 7, now: updatedAt + DAY })
    const outWindow = aggregateTaskStats({ days: 7, now: updatedAt + 30 * DAY })
    expect(inWindow.totalTokens).toBe(100)
    expect(inWindow.successRate).toBe(1)
    expect(outWindow.totalTokens).toBe(0)
    expect(outWindow.successRate).toBe(0)
  })
})

describe('任务统计的明细列表（B4）', () => {
  it('tasks 条数 = 窗口内任务数，字段齐全', () => {
    const a = createTask({ sessionId: 's1', status: 'running', label: '代码审计' })
    recordTaskOutcome(a.task_id, { tokens: 120, costUsd: 0.02, durationMs: 8000 })
    failTask(a.task_id, 'billing', '额度不足')

    const st = aggregateTaskStats()
    expect(st.tasks).toHaveLength(1)
    const row = st.tasks[0]
    expect(row).toMatchObject({
      task_id: a.task_id,
      session_id: 's1',
      label: '代码审计',
      status: 'failed',
      tokens: 120,
      duration_ms: 8000,
    })
    expect(row.cost_usd).toBeCloseTo(0.02)
    expect(row.failure_message, '失败任务要带调用方给的人话原因').toBe('额度不足')
    expect(typeof row.updated_at).toBe('number')
  })

  it('按 updated_at 倒序（最近的在最前）', () => {
    const a = createTask({ sessionId: 's1', status: 'running' })
    const b = createTask({ sessionId: 's2', status: 'running' })
    // 显式把 a 的更新时间推早，避免同毫秒导致的顺序不确定
    const aRec = getTask(a.task_id)!
    ;(aRec as any).updated_at = b.updated_at - 1000
    const st = aggregateTaskStats()
    expect(st.tasks.map((t) => t.task_id)).toEqual([b.task_id, a.task_id])
  })

  it('limit 生效且被夹在 1..500', () => {
    for (let i = 0; i < 5; i++) createTask({ sessionId: `s${i}`, status: 'running' })
    expect(aggregateTaskStats({ limit: 2 }).tasks).toHaveLength(2)
    expect(aggregateTaskStats({ limit: 0 }).tasks).toHaveLength(5) // 0 → 默认 50，不裁
    expect(aggregateTaskStats({ limit: 9999 }).tasks).toHaveLength(5) // 夹到 500，仍不裁
    expect(aggregateTaskStats({ limit: -5 }).tasks).toHaveLength(5) // 负数 → 默认值
  })

  it('空注册表时 tasks 是空数组而不是 undefined', () => {
    const st = aggregateTaskStats({ days: 7 })
    expect(Array.isArray(st.tasks)).toBe(true)
    expect(st.tasks).toHaveLength(0)
    expect(st.windowDays).toBe(7)
  })
})
