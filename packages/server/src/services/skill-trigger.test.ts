import { describe, expect, it } from 'vitest'
import { matchesSkillKeywords } from './skill-trigger'

describe('skill trigger matching', () => {
  it('does not activate all skills on an empty or whitespace-only request', () => {
    expect(matchesSkillKeywords('', 'brainstorming, creative')).toBe(false)
    expect(matchesSkillKeywords('   ', 'brainstorming, creative')).toBe(false)
  })
  it('preserves existing case-insensitive keyword and partial matching', () => {
    expect(matchesSkillKeywords('Please BRAINSTORM a feature', 'brainstorm, creative')).toBe(true)
    expect(matchesSkillKeywords('brain', 'brainstorming')).toBe(true)
    expect(matchesSkillKeywords('查询天气', 'brainstorming, creative')).toBe(false)
  })
})
