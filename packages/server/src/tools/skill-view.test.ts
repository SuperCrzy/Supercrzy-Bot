import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('../services/database', () => ({ getDB: () => state.db }))
import skillView from './skill-view'

beforeEach(() => {
  state.db = new Database(':memory:')
  state.db.exec('CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT, description TEXT, category TEXT, enabled INTEGER, is_builtin INTEGER, trigger_keywords TEXT, tools TEXT, prompt_template TEXT, source_file TEXT)')
  const insert = state.db.prepare('INSERT INTO skills VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?)')
  insert.run('11111111-2222-3333-4444-555555555555', 'superpowers/brainstorming', 'Think first', 'general', 'brainstorming', '[]', 'First explore the problem', '')
  insert.run('other', 'brainstorming-lite', 'Other', 'general', '', '[]', 'Different instructions', '')
})
afterEach(() => state.db.close())

describe('skill_view', () => {
  it('loads a long installed skill by exact name instead of treating it as an ID', async () => {
    const result = await skillView.execute({ name: 'superpowers/brainstorming' })
    expect(result).toContain('=== superpowers/brainstorming ===')
    expect(result).toContain('First explore the problem')
  })
  it('supports explicit ID and legacy UUID in the name field', async () => {
    const id = '11111111-2222-3333-4444-555555555555'
    expect(await skillView.execute({ id })).toContain('superpowers/brainstorming')
    expect(await skillView.execute({ name: id })).toContain('superpowers/brainstorming')
  })
  it('does not silently pick one of several partial matches', async () => {
    const result = await skillView.execute({ name: 'brainstorming' })
    expect(result).toContain('Multiple skills match')
    expect(result).not.toContain('Prompt Template')
  })
  it('treats SQL wildcard characters as literal input', async () => {
    expect(await skillView.execute({ name: '%' })).toContain('Skill not found')
  })
})
