/**
 * assessAbsenceClaim is the rule that should have blocked a real mistake: a bundle
 * grep finding no "mcp" was treated as proof there was no MCP UI, when the UI was
 * in SettingsView.vue all along. These cases pin the "weak evidence is not proof"
 * boundary, in both directions — it must reject thin evidence and accept real work,
 * or it becomes noise the model learns to skip.
 */
import { describe, it, expect } from 'vitest'
import { assessAbsenceClaim } from './verify-claim'
import tool from './verify-claim'

describe('assessAbsenceClaim', () => {
  it('rejects the bundle-grep mistake that started this', () => {
    const r = assessAbsenceClaim(['bundle_grep'])
    expect(r.supports).toBe(false)
    expect(r.verdict).toContain('NOT SUPPORTED')
  })

  it('rejects database row counts as evidence of absence', () => {
    // mcp_servers = 0 means no servers configured, not that the feature is missing.
    expect(assessAbsenceClaim(['db_rows']).supports).toBe(false)
  })

  it('rejects a bare file name', () => {
    expect(assessAbsenceClaim(['filename']).supports).toBe(false)
  })

  it('rejects weak evidence even when several kinds are stacked', () => {
    // Stacking three indirect signals does not add up to a direct one.
    expect(assessAbsenceClaim(['db_rows', 'bundle_grep', 'filename']).supports).toBe(false)
  })

  it('rejects a single source search — one dimension is not enough', () => {
    const r = assessAbsenceClaim(['source_grep'], 1)
    expect(r.supports).toBe(false)
    expect(r.verdict).toContain('two distinct names')
  })

  it('accepts two distinct source searches', () => {
    const r = assessAbsenceClaim(['source_grep'], 2)
    expect(r.supports).toBe(true)
    expect(r.verdict).toContain('[已核实]')
  })

  it('accepts reading the implementation', () => {
    expect(assessAbsenceClaim(['source_grep', 'source_read'], 2).supports).toBe(true)
  })

  it('accepts having actually run it', () => {
    expect(assessAbsenceClaim(['runtime']).supports).toBe(true)
  })

  it('notes the weak signals alongside the strong one', () => {
    const r = assessAbsenceClaim(['source_grep', 'db_rows'], 2)
    expect(r.supports).toBe(true)
    expect(r.verdict).toContain('db_rows')
  })
})

describe('verify_claim tool', () => {
  it('reports insufficient evidence for a db-only claim', async () => {
    const out = String(await tool.execute({
      claim: 'the client has no MCP management UI',
      evidence: ['db_rows', 'bundle_grep'],
      locations: ['packages/client/dist'],
    }))
    expect(out).toContain('⛔')
    expect(out).toContain('证据不足')
  })

  it('reports sufficient evidence once the source was read', async () => {
    const out = String(await tool.execute({
      claim: 'no such setting exists',
      evidence: ['source_grep', 'source_read'],
      distinctQueries: 3,
      locations: ['packages/client/src/views/SettingsView.vue'],
    }))
    expect(out).toContain('✅')
    expect(out).toContain('证据充分')
  })

  it('ignores unknown evidence kinds instead of trusting them', async () => {
    const out = String(await tool.execute({
      claim: 'x', evidence: ['vibes', 'db_rows'],
    }))
    expect(out).toContain('⛔')
  })

  it('requires a claim', async () => {
    expect(String(await tool.execute({ evidence: ['runtime'] }))).toContain('❌')
  })
})
