import { describe, expect, it } from 'vitest'
import { isUnsuccessfulAgentEvent, nextAgentEventSequence } from './agent-event-outcome'

describe('agent task outcome', () => {
  it('does not treat failed, stopped, paused or unfinished tasks as successful', () => {
    expect(isUnsuccessfulAgentEvent('error', { message: 'failed' })).toBe(true)
    expect(isUnsuccessfulAgentEvent('error', { stopped: true })).toBe(true)
    expect(isUnsuccessfulAgentEvent('error', { paused: true })).toBe(true)
    expect(isUnsuccessfulAgentEvent('task_state', { status: 'cancelled' })).toBe(true)
    expect(isUnsuccessfulAgentEvent('done', { finished: false })).toBe(true)
  })
  it('does not treat retry notices or successful completion as terminal failure', () => {
    expect(isUnsuccessfulAgentEvent('error', { retrying: true })).toBe(false)
    expect(isUnsuccessfulAgentEvent('done', { finished: true })).toBe(false)
    expect(isUnsuccessfulAgentEvent('done', {})).toBe(false)
  })
})

describe('agent event sequence', () => {
  it('accepts unnumbered errors even after numbered events', () => {
    expect(nextAgentEventSequence('', 7)).toBe(7)
    expect(nextAgentEventSequence('8', 7)).toBe(8)
    expect(nextAgentEventSequence('7', 7)).toBeNull()
    expect(nextAgentEventSequence('6', 7)).toBeNull()
  })
  it('does not mistake a malformed id for a numbered duplicate', () => {
    expect(nextAgentEventSequence('7x', 7)).toBe(7)
  })
})
