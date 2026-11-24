import { describe, expect, it } from 'vitest'
import { blocksSend, isAuthFailure } from './chat-auth'

describe('sign-in gate for sending', () => {
  it('treats 401 as a sign-in problem and nothing else', () => {
    expect(isAuthFailure(401)).toBe(true)
    expect(isAuthFailure(503)).toBe(false)
    expect(isAuthFailure(500)).toBe(false)
  })

  it('blocks sending only when there is no account', () => {
    expect(blocksSend(false)).toBe(true)
    expect(blocksSend(true)).toBe(false)
  })
})
