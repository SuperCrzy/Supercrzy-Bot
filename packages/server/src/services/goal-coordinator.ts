import type Database from 'better-sqlite3'
import { appendGoalEvent, claimGoalRun, getOpenPersistentGoal, recordGoalProgress, requestGoalPause, settleGoalRun, type PersistentGoal } from './persistent-goals'

export type GoalRunResult = { outcome: 'paused' | 'waiting_user' | 'interrupted'; summary: string; progressFingerprint?: string }
export type GoalExecutionOptions = { model?: string; language?: string }
export type GoalRunner = (input: { goal: PersistentGoal; runId: string; signal: AbortSignal; emit: (event: string, payload: unknown) => void; options?: GoalExecutionOptions }) => Promise<GoalRunResult>

/** Coordinates one owned run. A runner must resolve only after its work actually stops. */
export class GoalCoordinator {
  private readonly running = new Map<string, { runId: string; controller: AbortController }>()
  constructor(private readonly db: Database.Database, private readonly runner: GoalRunner | { create: () => GoalRunner }) {}

  start(sessionId: string, goalId: string, version: number, options?: GoalExecutionOptions): { runId: string; completion: Promise<void> } | undefined {
    const goal = getOpenPersistentGoal(this.db, sessionId)
    if (!goal || goal.id !== goalId || goal.version !== version || this.running.has(goalId)) return undefined
    const runner = typeof this.runner === 'function' ? this.runner : this.runner.create()
    const runId = claimGoalRun(this.db, sessionId, goalId, version)
    if (!runId) return undefined
    const controller = new AbortController()
    this.running.set(goalId, { runId, controller })
    const emit = (event: string, payload: unknown) => {
      if (!appendGoalEvent(this.db, goalId, runId, event, payload)) throw new Error('goal_run_not_active')
    }
    const completion = Promise.resolve().then(async () => {
      let currentGoal = goal
      const seen = new Set<string>()
      const maxTurns = 3
      for (let turn = 0; turn < maxTurns; turn++) {
        if (controller.signal.aborted) { settleGoalRun(this.db, goalId, runId, 'paused', currentGoal.last_result); return }
        const result = await runner({ goal: currentGoal, runId, signal: controller.signal, emit, options })
        if (!['paused', 'waiting_user', 'interrupted'].includes(result?.outcome) || typeof result.summary !== 'string') throw new Error('invalid_runner_result')
        const canContinue = result.outcome === 'paused' && !controller.signal.aborted && typeof result.progressFingerprint === 'string' && /^[a-f0-9]{64}$/.test(result.progressFingerprint) && !seen.has(result.progressFingerprint)
        if (!canContinue || turn === maxTurns - 1) {
          settleGoalRun(this.db, goalId, runId, result.outcome, result.summary.slice(0, 20_000))
          return
        }
        seen.add(result.progressFingerprint!)
        if (!recordGoalProgress(this.db, goalId, runId, result.summary)) {
          settleGoalRun(this.db, goalId, runId, 'paused', result.summary.slice(0, 20_000))
          return
        }
        emit('goal_turn', { turn: turn + 1, summary: result.summary.slice(0, 2000) })
        const next = getOpenPersistentGoal(this.db, sessionId)
        if (!next || next.id !== goalId || next.current_run_id !== runId) return
        currentGoal = next
      }
    })
      .catch(error => {
        // An exception does not prove tools stopped safely or that work completed.
        const reason = error instanceof Error ? error.message : 'runner_failed'
        settleGoalRun(this.db, goalId, runId, 'interrupted', reason.slice(0, 1000))
      })
      .finally(() => {
        if (this.running.get(goalId)?.runId === runId) this.running.delete(goalId)
      })
    return { runId, completion }
  }

  pause(sessionId: string, goalId: string, version: number): boolean {
    const owned = this.running.get(goalId)
    if (!owned) return false
    const runId = requestGoalPause(this.db, sessionId, goalId, version, Date.now(), owned.runId)
    if (!runId || runId !== owned.runId) return false
    owned.controller.abort()
    return true
  }
}
