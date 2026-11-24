import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlanStore } from './plan'

describe('plan completion', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('does not show a stopped task as completed', () => {
    const plan = usePlanStore()
    plan.setPlanUpdate({ planId: 'p', title: 'Task', steps: [{ id: 's', subject: 'Work', status: 'completed' }] })
    plan.markPlanFinished(false)
    expect(plan.planFinished).toBe(false)
    expect(plan.planInterrupted).toBe(true)
    plan.markPlanFinished(true)
    expect(plan.planFinished).toBe(true)
    expect(plan.planInterrupted).toBe(false)
    plan.markPlanFinished(false)
    plan.resetProgress()
    expect(plan.planInterrupted).toBe(false)
  })
})
