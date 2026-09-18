/**
 * 阶段二-② 暂停/恢复单测
 *
 * 语义要点（与"停止"的区别必须锁死）：
 *   - 停止 = 终态（cancelled），不可恢复
 *   - 暂停 = 非终态（paused），保留 checkpoint，可 resume 回 running
 *   - 两者都遵循"请求只打标记、状态由 loop 在轮次边界落地"的设计
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  __resetTaskState,
  createTask,
  getTask,
  requestTaskPause,
  isPauseRequested,
  clearTaskPause,
  pauseTask,
  resumeTask,
  isPaused,
  requestTaskCancel,
  setTaskStatus,
  mapAgentOutcome,
  canTransition,
} from '../services/task-state'

beforeEach(() => __resetTaskState())

describe('暂停：请求只打标记，不改状态', () => {
  it('requestTaskPause 后状态仍是 running，但被标记为需暂停', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    expect(requestTaskPause(t.task_id)).toBe(true)
    expect(getTask(t.task_id)!.status).toBe('running') // 关键：状态未被改
    expect(getTask(t.task_id)!.pause_requested_at).toBeTypeOf('number')
    expect(isPauseRequested(t.task_id)).toBe(true)
  })

  it('已处于 paused 的任务再请求暂停是幂等的（返回 true 但不重复打标记）', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    setTaskStatus(t.task_id, 'paused')
    const before = getTask(t.task_id)!.pause_requested_at
    expect(requestTaskPause(t.task_id)).toBe(true)
    expect(getTask(t.task_id)!.pause_requested_at).toBe(before)
    // 已是 paused，不该再被判定为"需暂停"（否则死循环）
    expect(isPauseRequested(t.task_id)).toBe(false)
  })

  it('终态任务不接受暂停请求', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    setTaskStatus(t.task_id, 'completed')
    expect(requestTaskPause(t.task_id)).toBe(false)
  })

  it('取消优先：已请求取消的任务不再接受暂停', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    requestTaskCancel(t.task_id)
    expect(requestTaskPause(t.task_id)).toBe(false)
  })

  it('不存在的任务返回 false（不抛异常）', () => {
    expect(requestTaskPause('nope')).toBe(false)
    expect(isPauseRequested('nope')).toBe(false)
    expect(pauseTask('nope')).toBe(false)
    expect(resumeTask('nope')).toBe(false)
  })
})

describe('暂停落地与恢复', () => {
  it('pauseTask: running → paused，并清掉请求标记', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    requestTaskPause(t.task_id)
    expect(pauseTask(t.task_id)).toBe(true)
    const rec = getTask(t.task_id)!
    expect(rec.status).toBe('paused')
    expect(rec.pause_requested_at).toBeNull() // 标记必须清，否则恢复后立刻又暂停
    expect(isPauseRequested(t.task_id)).toBe(false)
    expect(isPaused(t.task_id)).toBe(true)
  })

  it('paused 不是终态：duration/tokens 统计不应把它当结束', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    pauseTask(t.task_id)
    const rec = getTask(t.task_id)!
    expect(rec.completed_at).toBeNull()
    expect(canTransition('paused', 'running')).toBe(true)
  })

  it('resumeTask: paused → running（状态可回到执行中）', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    pauseTask(t.task_id)
    expect(resumeTask(t.task_id)).toBe(true)
    expect(getTask(t.task_id)!.status).toBe('running')
    expect(isPaused(t.task_id)).toBe(false)
  })

  it('resumeTask 对非 paused 状态返回 false（幂等防误用）', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    expect(resumeTask(t.task_id)).toBe(false)
  })

  it('已取消的任务不允许恢复', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    pauseTask(t.task_id)
    requestTaskCancel(t.task_id)
    setTaskStatus(t.task_id, 'cancelled', { force: true })
    expect(resumeTask(t.task_id)).toBe(false)
  })

  it('clearTaskPause 可单独清除标记（loop 入口复用）', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    requestTaskPause(t.task_id)
    clearTaskPause(t.task_id)
    expect(getTask(t.task_id)!.pause_requested_at).toBeNull()
    expect(isPauseRequested(t.task_id)).toBe(false)
  })

  it('暂停→恢复→再暂停，三段完整闭环都不丢状态', () => {
    const t = createTask({ sessionId: 's1', status: 'running' })
    requestTaskPause(t.task_id)
    pauseTask(t.task_id)
    expect(isPaused(t.task_id)).toBe(true)
    resumeTask(t.task_id)
    expect(getTask(t.task_id)!.status).toBe('running')
    requestTaskPause(t.task_id)
    expect(isPauseRequested(t.task_id)).toBe(true)
    pauseTask(t.task_id)
    expect(isPaused(t.task_id)).toBe(true)
  })
})

describe('收尾映射：paused 与 cancelled 必须区分', () => {
  it('user_paused → paused（非终态，可恢复）', () => {
    expect(mapAgentOutcome('user_paused')).toBe('paused')
  })

  it('user_stopped → cancelled（终态，不可恢复）—— 与暂停不能混淆', () => {
    expect(mapAgentOutcome('user_stopped')).toBe('cancelled')
  })

  it('paused 不在终态集合里', () => {
    // 通过状态机行为间接验证：paused 还能转 running，cancelled 不能
    expect(canTransition('paused', 'running')).toBe(true)
    expect(canTransition('cancelled', 'running')).toBe(false)
  })
})
