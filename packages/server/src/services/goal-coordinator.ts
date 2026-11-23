import type Database from 'better-sqlite3'
import { appendGoalEvent, claimGoalRun, getOpenPersistentGoal, requestGoalPause, settleGoalRun, type PersistentGoal } from './persistent-goals'

export type GoalRunResult = { outcome: 'paused' | 'waiting_user' | 'interrupted'; summary: string }
export type GoalRunner = (input: { goal: PersistentGoal; runId: string; signal: AbortSignal; emit: (event: string, payload: unknown) => void }) => Promise<GoalRunResult>

/** Coordinates one owned run. A runner must resolve only after its work actually stops. */
export class GoalCoordinator {
  private readonly running = new Map<string, { runId: string; controller: AbortController }>()
  constructor(private readonly db: Database.Database, private readonly runner: GoalRunner) {}

  start(sessionId: string, goalId: string, version: number): { runId: string; completion: Promise<void> } | undefined {
    const goal = getOpenPersistentGoal(this.db, sessionId)
    if (!goal || goal.id !== goalId || goal.version !== version || this.running.has(goalId)) return undefined
    const runId = claimGoalRun(this.db, sessionId, goalId, version)
    if (!runId) return undefined
    const controller = new AbortController()
    this.running.set(goalId, { runId, controller })
    const emit = (event: string, payload: unknown) => {
      if (!appendGoalEvent(this.db, goalId, runId, event, payload)) throw new Error('goal_run_not_active')
    }
    const completion = Promise.resolve().then(() => this.runner({ goal, runId, signal: controller.signal, emit }))
      .then(result => {
        if (!['paused', 'waiting_user', 'interrupted'].includes(result?.outcome) || typeof result.summary !== 'string') throw new Error('invalid_runner_result')
        settleGoalRun(this.db, goalId, runId, result.outcome, result.summary.slice(0, 20_000))
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
