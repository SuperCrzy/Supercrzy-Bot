/**
 * The personality files are injected into every prompt, so two things matter:
 * a missing file must not add empty scaffolding, and an oversized file must not
 * silently cost thousands of tokens on every turn.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let home: string
let mod: typeof import('./personality')

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'persona-'))
  vi.stubEnv('HOME', home)
  vi.resetModules()
  mod = await import('./personality')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('personality files', () => {
  it('adds nothing to the prompt when no file exists', () => {
    // A fresh install must not carry headings for empty files.
    expect(mod.buildPersonalitySection()).toBe('')
  })

  it('seeds starter files without overwriting edits', () => {
    mod.seedPersonalityIfMissing()
    expect(existsSync(mod.personalityPath('soul'))).toBe(true)

    mod.writePersonality('soul', 'MY OWN STYLE RULES')
    mod.seedPersonalityIfMissing()
    // Seeding again on the next boot must not discard the user's edit.
    expect(mod.readPersonality('soul')).toBe('MY OWN STYLE RULES')
  })

  it('includes each file under its own heading', () => {
    mod.writePersonality('soul', '- be brief')
    mod.writePersonality('user', 'Jeff, runs the project')
    const s = mod.buildPersonalitySection()
    expect(s).toContain('Style (SOUL.md)')
    expect(s).toContain('be brief')
    expect(s).toContain('About the user (USER.md)')
    expect(s).toContain('Jeff, runs the project')
  })

  it('omits only the files that are missing', () => {
    mod.writePersonality('user', 'only the user file')
    const s = mod.buildPersonalitySection()
    expect(s).toContain('only the user file')
    expect(s).not.toContain('SOUL.md')
  })

  it('caps a long file in the middle and says so', () => {
    const long = 'A'.repeat(1500) + 'B'.repeat(3000) + 'C'.repeat(1500)
    mod.writePersonality('soul', long)
    const out = mod.readPersonality('soul')
    expect(out.length).toBeLessThan(long.length)
    expect(out).toContain('middle omitted')
    // Both ends survive: the opening states intent, the tail often holds later rules.
    expect(out.startsWith('AAA')).toBe(true)
    expect(out.endsWith('CCC')).toBe(true)
  })

  it('leaves a file under the cap untouched', () => {
    const text = 'x'.repeat(100)
    mod.writePersonality('identity', text)
    expect(mod.readPersonality('identity')).toBe(text)
  })
})
