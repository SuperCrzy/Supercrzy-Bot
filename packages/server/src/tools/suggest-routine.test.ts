/**
 * suggest_routine replaces a mechanical trigger (>=3 turns and >=3 tool calls) that
 * fired on one-off work as readily as on a weekly chore, so the card appeared after
 * almost every reply. The model now decides; these tests pin the bookkeeping the
 * agent loop relies on, not the model's judgement.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import tool, { takeRoutineSuggestion, clearRoutineSuggestion } from './suggest-routine'

const ctx = (sessionId: string) => ({ sessionId }) as any

describe('suggest_routine', () => {
  beforeEach(() => {
    clearRoutineSuggestion('s1')
    clearRoutineSuggestion('s2')
  })

  it('records a suggestion for the calling session', async () => {
    await tool.execute({ title: '每日网站流量查询', reason: '用户说每天都要查' }, ctx('s1'))
    expect(takeRoutineSuggestion('s1')).toEqual({ title: '每日网站流量查询', reason: '用户说每天都要查' })
  })

  it('hands the suggestion over exactly once', async () => {
    await tool.execute({ title: 'A' }, ctx('s1'))
    expect(takeRoutineSuggestion('s1')).toBeTruthy()
    // The agent loop reads it at turn end; a second read must not resurface it.
    expect(takeRoutineSuggestion('s1')).toBeUndefined()
  })

  it('keeps sessions apart', async () => {
    await tool.execute({ title: 'only-s1' }, ctx('s1'))
    expect(takeRoutineSuggestion('s2')).toBeUndefined()
    expect(takeRoutineSuggestion('s1')?.title).toBe('only-s1')
  })

  it('rejects an empty title instead of storing a blank card', async () => {
    const out = await tool.execute({ title: '   ' }, ctx('s1'))
    expect(String(out)).toContain('❌')
    expect(takeRoutineSuggestion('s1')).toBeUndefined()
  })

  it('does not stack a second card in the same turn', async () => {
    await tool.execute({ title: 'first' }, ctx('s1'))
    await tool.execute({ title: 'second' }, ctx('s1'))
    expect(takeRoutineSuggestion('s1')?.title).toBe('first')
  })

  it('clearRoutineSuggestion drops a stale suggestion', async () => {
    await tool.execute({ title: 'ignored-by-user' }, ctx('s1'))
    // The next turn starts with a clean slate: an ignored card must not reappear.
    clearRoutineSuggestion('s1')
    expect(takeRoutineSuggestion('s1')).toBeUndefined()
  })
})
