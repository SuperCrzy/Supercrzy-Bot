import { describe, expect, it } from 'vitest'
import { slashCommands } from './useInputTrigger'

const t = (key: string) => key

describe('/ menu', () => {
  it('offers /goal when the goal bar is usable', () => {
    const labels = slashCommands(t, { goalsEnabled: true }).map((c) => c.label)
    expect(labels).toEqual(['/new', '/search', '/help', '/skill', '/goal'])
  })

  it('hides /goal when goals are switched off, so the menu never promises a missing control', () => {
    const labels = slashCommands(t, { goalsEnabled: false }).map((c) => c.label)
    expect(labels).not.toContain('/goal')
    expect(labels).toHaveLength(4)
  })
})
