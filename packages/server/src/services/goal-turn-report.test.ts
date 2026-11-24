import { describe, expect, it } from 'vitest'
import { parseGoalTurnReport } from './goal-turn-report'

const calls = new Map([['one', { name: 'file_read', arguments: '{"path":"a"}' }]])
const results = new Map([['one', { content: 'contents', denied: false }]])
const report = (ids: unknown) => `已读取文件。\n<goal_report>{"action":"continue","evidence_call_ids":${JSON.stringify(ids)}}</goal_report>`

describe('goal turn report', () => {
  it('requires a matching observed successful tool call before continuing', () => {
    const parsed = parseGoalTurnReport(report(['one']), calls, results, false)
    expect(parsed.summary).toBe('已读取文件。')
    expect(parsed.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(parseGoalTurnReport(report(['missing']), calls, results, false).fingerprint).toBeUndefined()
    expect(parseGoalTurnReport(report(['one']), calls, new Map([['one', { content: '❌ failed', denied: false }]]), false).fingerprint).toBeUndefined()
    expect(parseGoalTurnReport(report(['one']), calls, results, true).fingerprint).toBeUndefined()
  })
  it('does not treat dispatcher failures as evidence of progress', () => {
    for (const content of ['Tool execution error: database unavailable', 'Failed to parse tool arguments: {}', 'Unknown tool: file_read', '⛔ 记忆功能已关闭', 'Skill not found: missing']) {
      expect(parseGoalTurnReport(report(['one']), calls, new Map([['one', { content, denied: false }]]), false).fingerprint).toBeUndefined()
    }
  })
  it('stops on missing, malformed or non-final reports', () => {
    expect(parseGoalTurnReport('done', calls, results, false).fingerprint).toBeUndefined()
    expect(parseGoalTurnReport('<goal_report>bad</goal_report>', calls, results, false).fingerprint).toBeUndefined()
    expect(parseGoalTurnReport(`${report(['one'])}\nextra`, calls, results, false).fingerprint).toBeUndefined()
  })
  it('does not continue after side effects even when the report cites only a read', () => {
    const mixed = new Map(calls)
    mixed.set('write', { name: 'file_write', arguments: '{"path":"a"}' })
    expect(parseGoalTurnReport(report(['one']), mixed, results, false).fingerprint).toBeUndefined()
    mixed.set('write', { name: 'shell_exec', arguments: '{"command":"echo hi"}' })
    expect(parseGoalTurnReport(report(['one']), mixed, results, false).fingerprint).toBeUndefined()
  })
  it('can continue after local skill and memory lookups, but not network or unknown tools', () => {
    for (const name of ['skill_list', 'skill_view', 'memory_list']) {
      const local = new Map([['one', { name, arguments: '{}' }]])
      expect(parseGoalTurnReport(report(['one']), local, results, false).fingerprint).toMatch(/^[a-f0-9]{64}$/)
    }
    for (const name of ['web_fetch', 'web_search', 'unknown']) {
      const other = new Map([['one', { name, arguments: '{}' }]])
      expect(parseGoalTurnReport(report(['one']), other, results, false).fingerprint).toBeUndefined()
    }
  })
})
