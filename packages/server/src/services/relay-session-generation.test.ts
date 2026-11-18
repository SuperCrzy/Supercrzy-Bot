import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  callbacks: new Map<string, (event: { type: string; taskId: string; sessionId: string }) => void>(),
  finishes: [] as Array<() => void>,
}))
vi.mock('./database', () => ({ getDB: () => ({ prepare: () => ({ get: (key: string) => state.settings.has(key) ? { value: state.settings.get(key) } : undefined }) }) }))
vi.mock('./account-store', () => ({ isSignedIn: () => true, readSession: () => ({ accountId: 'same-account' }) }))
vi.mock('./account-auth', () => ({ ensureAccessToken: async () => null }))
vi.mock('./remote-task-bridge', () => ({
  cancelRemoteTask: () => false,
  runRemoteTask: (options: { taskId: string; onEvent: (event: { type: string; taskId: string; sessionId: string }) => void }) => {
    state.callbacks.set(options.taskId, options.onEvent)
    return new Promise((resolve) => state.finishes.push(() => resolve({ sessionId: 'session', duplicate: false, status: 'completed' })))
  },
}))
import { startRelayClient, stopRelayClient } from './relay-client'

async function waitFor(condition: () => boolean): Promise<void> {
  const end = Date.now() + 3000
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting for relay')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(() => {
  stopRelayClient()
  for (const finish of state.finishes.splice(0)) finish()
  state.callbacks.clear()
  state.settings.clear()
})

describe('relay login session boundary', () => {
  it('does not send an old task event to a new connection after the same account reconnects', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const sockets: WebSocket[] = []
    const received: Array<{ params: { taskId: string } }> = []
    server.on('connection', (socket) => {
      sockets.push(socket)
      socket.on('message', (raw) => received.push(JSON.parse(String(raw))))
    })
    const oldOrigin = process.env.SUPERCRZY_AUTH_ORIGIN
    process.env.SUPERCRZY_AUTH_ORIGIN = 'https://test.invalid'
    const port = (server.address() as { port: number }).port
    const settings: Record<string, string> = {
      workspaceAccountId: 'same-account', workspaceAuthOrigin: 'https://test.invalid', workspaceChannel: 'test-channel',
      workspaceConnectionToken: 'test-token', workspaceTokenExpiresAt: String(Date.now() + 300_000), workspaceRelayUrl: `ws://127.0.0.1:${port}`,
    }
    for (const [key, value] of Object.entries(settings)) state.settings.set(key, value)
    try {
      startRelayClient()
      await waitFor(() => sockets.length === 1)
      sockets[0].send(JSON.stringify({ method: 'session/prompt', params: { taskId: 'old', text: 'first' } }))
      await waitFor(() => state.callbacks.has('old'))
      stopRelayClient()
      startRelayClient()
      await waitFor(() => sockets.length === 2)
      sockets[1].send(JSON.stringify({ method: 'session/prompt', params: { taskId: 'new', text: 'second' } }))
      await waitFor(() => state.callbacks.has('new'))
      state.callbacks.get('old')!({ type: 'completed', taskId: 'old', sessionId: 'old-session' })
      state.callbacks.get('new')!({ type: 'completed', taskId: 'new', sessionId: 'new-session' })
      await waitFor(() => received.length > 0)
      expect(received.map((message) => message.params.taskId)).toEqual(['new'])
    } finally {
      stopRelayClient()
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (oldOrigin === undefined) delete process.env.SUPERCRZY_AUTH_ORIGIN
      else process.env.SUPERCRZY_AUTH_ORIGIN = oldOrigin
    }
  })
})
