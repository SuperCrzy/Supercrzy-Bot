import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import Koa from 'koa'
import request from 'supertest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('../services/database', () => ({ getDB: () => state.db }))
vi.mock('../config', () => ({ config: { workspaceDir: '/private/workspace' } }))
vi.mock('node:os', async (original) => ({ ...(await original<typeof import('node:os')>()), homedir: () => '/nonexistent-supercrzy-diagnostic-test' }))
import { diagnoseRouter, summarizeLogs, summarizeSettings } from './diagnose'

beforeEach(() => {
  state.db = new Database(':memory:')
  state.db.exec('CREATE TABLE settings (key TEXT, value TEXT)')
})
afterEach(() => state.db.close())

describe('diagnostic privacy', () => {
  it('allows only safe configuration metadata, never free text or disguised secrets', () => {
    const safe = summarizeSettings([
      { key: 'maxTokens', value: '4096' }, { key: 'streamingEnabled', value: 'true' },
      { key: 'apiKey', value: 'secret-key-fixture' }, { key: 'systemPrompt', value: 'private-prompt-fixture' },
      { key: 'username', value: 'private-user-fixture' }, { key: 'proxyConfig', value: '{"token":"secret-token-fixture"}' },
      { key: 'temperature', value: 'malformed-secret-fixture' },
    ])
    expect(safe).toEqual({ maxTokens: 4096, streamingEnabled: true, apiKeyConfigured: true, systemPromptConfigured: true })
    expect(JSON.stringify(safe)).not.toMatch(/fixture|private|secret/)
  })

  it('exports log metadata without names, paths or log content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diagnose-test-'))
    try {
      writeFileSync(join(dir, 'private-name.log'), 'secret-log-fixture\nprivate-message-fixture')
      const summary = summarizeLogs(dir)
      expect(summary).toEqual({ available: true, latestSizeBytes: 42 })
      expect(JSON.stringify(summary)).not.toMatch(/private|secret|fixture/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('does not expose sensitive settings in the HTTP bundle', async () => {
    const insert = state.db.prepare('INSERT INTO settings (key,value) VALUES (?,?)')
    insert.run('apiKey', 'secret-key-fixture'); insert.run('systemPrompt', 'private-prompt-fixture')
    insert.run('username', 'private-user-fixture'); insert.run('maxTokens', '3000')
    const app = new Koa(); app.use(diagnoseRouter.routes())
    const response = await request(app.callback()).get('/api/diagnose/bundle')
    expect(response.status).toBe(200)
    expect(response.body.capabilities.settings).toMatchObject({ apiKeyConfigured: true, systemPromptConfigured: true, maxTokens: 3000 })
    expect(JSON.stringify(response.body)).not.toMatch(/secret-key-fixture|private-prompt-fixture|private-user-fixture|private\/workspace/)
  })
})
