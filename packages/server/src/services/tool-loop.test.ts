import { beforeEach, describe, expect, it } from 'vitest'
import { detectToolLoop, resetToolLoopHistory } from './agent'

const call = (name: string, args: unknown) => ({ function: { name, arguments: JSON.stringify(args) } })

describe('detectToolLoop', () => {
  beforeEach(() => resetToolLoopHistory())

  it('repeated identical calls to a normal tool trip at the 6th call', () => {
    let hit = null
    for (let i = 0; i < 6; i++) hit = detectToolLoop([call('shell_exec', { command: 'npm test' })])
    expect(hit).toEqual({ name: 'shell_exec', count: 6 })
  })

  it('does not trip before the threshold', () => {
    let hit = null
    for (let i = 0; i < 5; i++) hit = detectToolLoop([call('shell_exec', { command: 'npm test' })])
    expect(hit).toBeNull()
  })

  it('different arguments never trip', () => {
    let hit = null
    for (let i = 0; i < 8; i++) hit = detectToolLoop([call('shell_exec', { command: `echo ${i}` })])
    expect(hit).toBeNull()
  })

  it('exempts the browser tool — identical snapshot/screenshot calls are normal', () => {
    let hit = null
    for (let i = 0; i < 10; i++) hit = detectToolLoop([call('browser', { action: 'snapshot' })])
    expect(hit).toBeNull()
  })
})
