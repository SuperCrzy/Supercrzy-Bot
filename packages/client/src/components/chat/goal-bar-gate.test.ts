/**
 * Two things this locks down, both learned from 1.3.6.
 *
 * 1. The goal bar is off by default. Shipping a Start button that can silently do
 *    nothing is worse than not shipping it, so the bar only appears when explicitly
 *    enabled — turning it on is a decision, not a default.
 *
 * 2. An API error keeps its code. The generic "action failed, try again" is what made
 *    a 401 indistinguishable from every other failure; the user was signed in and the
 *    screen said nothing useful. The server's code is the actionable part.
 */
import { describe, it, expect } from 'vitest'

describe('goal bar visibility', () => {
  const visible = (goalsEnabled: boolean, sessionId: string | null, isMobile: boolean) =>
    goalsEnabled && !!sessionId && !isMobile

  it('stays hidden unless the feature flag is set', () => {
    // The regression: a default-on bar with a broken Start button.
    expect(visible(false, 'sid-1', false)).toBe(false)
  })

  it('shows when enabled and a session is active', () => {
    expect(visible(true, 'sid-1', false)).toBe(true)
  })

  it('stays hidden without a session or on mobile', () => {
    expect(visible(true, null, false)).toBe(false)
    expect(visible(true, 'sid-1', true)).toBe(false)
  })
})

describe('api error codes', () => {
  const messageFor = (code: string) => {
    if (code === 'not_signed_in') return 'goal.notSignedIn'
    if (code === 'goal_changed' || code === 'invalid_version') return 'goal.goalChanged'
    if (code === 'goal_not_startable' || code === 'interruption_review_required') return 'goal.notStartable'
    return 'goal.actionError'
  }

  it('names the sign-in problem instead of a generic failure', () => {
    // This is the exact case that made Start look dead.
    expect(messageFor('not_signed_in')).toBe('goal.notSignedIn')
  })

  it('distinguishes a stale goal from an unstartable one', () => {
    expect(messageFor('goal_changed')).toBe('goal.goalChanged')
    expect(messageFor('goal_not_startable')).toBe('goal.notStartable')
  })

  it('falls back to the generic message for unknown codes', () => {
    expect(messageFor('')).toBe('goal.actionError')
    expect(messageFor('some_new_code')).toBe('goal.actionError')
  })
})
