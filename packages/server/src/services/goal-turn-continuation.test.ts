/**
 * A goal that writes something may continue — if the write was verified in-turn.
 *
 * The rule used to be "any non-read-only call stops the goal". A goal to create three
 * files therefore ran one turn and stopped, which is not a persistent goal. The valid
 * concern behind the rule is duplication: without idempotency, re-running a write can
 * apply its effect twice.
 *
 * The compromise tested here: a write counts as progress only when a later file_read in
 * the same turn looked at the same path. The goal may then continue. A write with no
 * read-back still stops it, and so does any tool whose effect cannot be checked from
 * inside the turn (network, shell, devices).
 */
import { describe, it, expect } from 'vitest'
import { parseGoalTurnReport } from './goal-turn-report'

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) })
const result = (content = 'ok') => ({ content, denied: false })
const report = (ids: string[]) =>
  `done for now\n<goal_report>{"action":"continue","evidence_call_ids":${JSON.stringify(ids)}}</goal_report>`

describe('continuing after a write', () => {
  it('continues when the write was read back in the same turn', () => {
    // The case that was impossible before: create a file, check it, move on.
    const calls = new Map([
      ['w1', call('file_write', { path: '/tmp/goal/a.txt', content: 'hello' })],
      ['r1', call('file_read', { path: '/tmp/goal/a.txt' })],
    ])
    const results = new Map([['w1', result('created')], ['r1', result('hello')]])
    const out = parseGoalTurnReport(report(['w1', 'r1']), calls, results, false)
    expect(out.fingerprint).toBeTruthy()
    expect(out.summary).toBe('done for now')
  })

  it('stops when the write was never read back', () => {
    const calls = new Map([['w1', call('file_write', { path: '/tmp/goal/a.txt', content: 'hello' })]])
    const results = new Map([['w1', result('created')]])
    const out = parseGoalTurnReport(report(['w1']), calls, results, false)
    expect(out.fingerprint).toBeUndefined()
  })

  it('stops when the read looked at a different file', () => {
    const calls = new Map([
      ['w1', call('file_write', { path: '/tmp/goal/a.txt', content: 'hello' })],
      ['r1', call('file_read', { path: '/tmp/goal/b.txt' })],
    ])
    const results = new Map([['w1', result('created')], ['r1', result('other')]])
    expect(parseGoalTurnReport(report(['w1', 'r1']), calls, results, false).fingerprint).toBeUndefined()
  })

  it('stops when the read happened before the write', () => {
    // Order matters: reading a file that is about to be overwritten proves nothing.
    const calls = new Map([
      ['r1', call('file_read', { path: '/tmp/goal/a.txt' })],
      ['w1', call('file_write', { path: '/tmp/goal/a.txt', content: 'hello' })],
    ])
    const results = new Map([['r1', result('before')], ['w1', result('created')]])
    expect(parseGoalTurnReport(report(['w1', 'r1']), calls, results, false).fingerprint).toBeUndefined()
  })

  it('accepts a relative read path for the same file', () => {
    const calls = new Map([
      ['w1', call('file_write', { path: '/tmp/goal/a.txt', content: 'x' })],
      ['r1', call('file_read', { path: '/tmp/goal/./a.txt' })],
    ])
    const results = new Map([['w1', result('created')], ['r1', result('x')]])
    expect(parseGoalTurnReport(report(['w1', 'r1']), calls, results, false).fingerprint).toBeTruthy()
  })

  it('continues after several verified writes', () => {
    // Three files, each created and checked — the goal this feature is for.
    const calls = new Map([
      ['w1', call('file_write', { path: '/tmp/g/1.txt', content: '1' })],
      ['r1', call('file_read', { path: '/tmp/g/1.txt' })],
      ['w2', call('file_write', { path: '/tmp/g/2.txt', content: '2' })],
      ['r2', call('file_read', { path: '/tmp/g/2.txt' })],
    ])
    const results = new Map(['w1', 'r1', 'w2', 'r2'].map((k) => [k, result('1')]))
    expect(parseGoalTurnReport(report(['w1', 'r1', 'w2', 'r2']), calls, results, false).fingerprint).toBeTruthy()
  })

  it('stops when one of several writes was not read back', () => {
    const calls = new Map([
      ['w1', call('file_write', { path: '/tmp/g/1.txt', content: '1' })],
      ['r1', call('file_read', { path: '/tmp/g/1.txt' })],
      ['w2', call('file_write', { path: '/tmp/g/2.txt', content: '2' })],
    ])
    const results = new Map(['w1', 'r1', 'w2'].map((k) => [k, result('1')]))
    expect(parseGoalTurnReport(report(['w1', 'w2']), calls, results, false).fingerprint).toBeUndefined()
  })

  it('still stops for a tool whose effect cannot be verified in-turn', () => {
    // shell_exec, network calls and device control remain outside the allowance:
    // re-running them has no in-turn proof that the first run is not repeated.
    const calls = new Map([
      ['w1', call('file_write', { path: '/tmp/g/1.txt', content: '1' })],
      ['r1', call('file_read', { path: '/tmp/g/1.txt' })],
      ['s1', call('shell_exec', { command: 'curl https://example.com' })],
    ])
    const results = new Map(['w1', 'r1', 's1'].map((k) => [k, result('ok')]))
    expect(parseGoalTurnReport(report(['w1', 'r1']), calls, results, false).fingerprint).toBeUndefined()
  })

  it('still stops when the turn asked the user something', () => {
    const calls = new Map([
      ['w1', call('file_write', { path: '/tmp/g/1.txt', content: '1' })],
      ['r1', call('file_read', { path: '/tmp/g/1.txt' })],
    ])
    const results = new Map([['w1', result('created')], ['r1', result('1')]])
    expect(parseGoalTurnReport(report(['w1', 'r1']), calls, results, true).fingerprint).toBeUndefined()
  })
})
