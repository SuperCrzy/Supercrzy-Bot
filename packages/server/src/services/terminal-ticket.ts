import { randomBytes } from 'node:crypto'

const TTL_MS = 30_000
const MAX_TICKETS = 128
const tickets = new Map<string, { accountId: string; expires: number }>()

/** A short-lived, single-use ticket; never store the account access token in a URL. */
export function issueTerminalTicket(accountId: string, now = Date.now()): string {
  for (const [ticket, entry] of tickets) if (entry.expires <= now) tickets.delete(ticket)
  while (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value!)
  const ticket = randomBytes(32).toString('base64url')
  tickets.set(ticket, { accountId, expires: now + TTL_MS })
  return ticket
}

export function consumeTerminalTicket(ticket: string, accountId: string, now = Date.now()): boolean {
  const entry = tickets.get(ticket)
  if (!entry) return false
  tickets.delete(ticket)
  return entry.accountId === accountId && entry.expires > now
}
