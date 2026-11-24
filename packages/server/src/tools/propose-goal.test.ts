import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../config', () => ({ config: { db: { path: ':memory:' } } }))
import { getDB, initDatabase } from '../services/database'
import { createPersistentGoal, getOpenPersistentGoal } from '../services/persistent-goals'
import proposeGoalTool from './propose-goal'

beforeEach(() => {
  process.env.DB_PATH = ':memory:'
  initDatabase()
  getDB().prepare("INSERT INTO sessions (id, title) VALUES ('s1', 'S1')").run()
})
afterEach(() => { getDB().close(); delete process.env.DB_PATH })

describe('propose_goal', () => {
  it('opens a paused goal the agent proposed, so it waits for the user', () => {
    const result = String(proposeGoalTool.execute({ objective: '把 X 从 A 迁到 B', acceptance: '全部测试通过' }, { sessionId: 's1' }))
    expect(result).toContain('已暂停')
    const goal = getOpenPersistentGoal(getDB(), 's1')
    expect(goal).toMatchObject({ objective: '把 X 从 A 迁到 B', acceptance: '全部测试通过', source: 'ai', status: 'paused' })
    expect(goal?.current_run_id).toBeNull()
  })

  it('refuses a second goal and says why instead of throwing', () => {
    proposeGoalTool.execute({ objective: '第一个' }, { sessionId: 's1' })
    const result = String(proposeGoalTool.execute({ objective: '第二个' }, { sessionId: 's1' }))
    expect(result).toContain('已有目标')
    expect(getOpenPersistentGoal(getDB(), 's1')?.objective).toBe('第一个')
  })

  it('rejects an empty objective and a missing session without touching the database', () => {
    expect(String(proposeGoalTool.execute({ objective: '   ' }, { sessionId: 's1' }))).toContain('objective')
    expect(String(proposeGoalTool.execute({ objective: 'x' }, {}))).toContain('会话')
    expect(getDB().prepare('SELECT COUNT(*) AS c FROM persistent_goals').get()).toEqual({ c: 0 })
  })

  it('marks a goal created through the API as the user\'s own', () => {
    const goal = createPersistentGoal(getDB(), 's1', 'user goal')
    expect(goal.source).toBe('user')
  })
})
