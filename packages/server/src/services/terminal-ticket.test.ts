import { describe, expect, it } from 'vitest'
import { consumeTerminalTicket, issueTerminalTicket } from './terminal-ticket'

describe('terminal WebSocket tickets', () => {
  it('accepts a ticket only once for its signed-in account', () => {
    const ticket = issueTerminalTicket('account-a', 1000)
    expect(consumeTerminalTicket(ticket, 'account-a', 1001)).toBe(true)
    expect(consumeTerminalTicket(ticket, 'account-a', 1002)).toBe(false)
  })

  it('rejects expired, unknown, and cross-account tickets', () => {
    expect(consumeTerminalTicket(issueTerminalTicket('account-a', 1000), 'account-a', 31_000)).toBe(false)
    expect(consumeTerminalTicket('unknown', 'account-a', 1001)).toBe(false)
    const ticket = issueTerminalTicket('account-a', 1000)
    expect(consumeTerminalTicket(ticket, 'account-b', 1001)).toBe(false)
    expect(consumeTerminalTicket(ticket, 'account-a', 1002)).toBe(false)
  })
})
