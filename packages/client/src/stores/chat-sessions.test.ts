import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from './chat'

vi.mock('@/i18n', () => ({ default: () => ({ global: { t: (key: string) => key } }) }))
vi.mock('./app', () => ({ useAppStore: () => ({ resetCtxUsage: () => {} }) }))

beforeEach(() => {
  setActivePinia(createPinia())
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
})
afterEach(() => vi.unstubAllGlobals())

describe('chat session loading', () => {
  it('restores archived sessions to the archive without selecting them as the current chat', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/settings') return Response.json({})
      if (url === '/api/sessions?archived=all') return Response.json([
        { id: 'archived', title: 'Archived', archived: 1, updated_at: '2026-01-02' },
        { id: 'active', title: 'Active', archived: 0, updated_at: '2026-01-01' },
      ])
      return Response.json({ messages: [] })
    }))
    const chat = useChatStore()
    await chat.loadSessions()
    expect(chat.archivedSessions.map((session) => session.id)).toEqual(['archived'])
    expect(chat.currentSessionId).toBe('active')
    expect(chat.groupedSessions.flatMap((group) => group.sessions.map((session) => session.id))).toEqual(['active'])
  })

  it('reloads the list after a restore even when already loaded', async () => {
    let rows = [{ id: 'existing', title: 'Existing', archived: 0, updated_at: '2026-01-01' }]
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/settings') return Response.json({})
      if (url === '/api/sessions?archived=all') return Response.json(rows)
      return Response.json({ messages: [] })
    }))
    const chat = useChatStore()
    await chat.loadSessions()
    rows = [...rows, { id: 'restored', title: 'Restored', archived: 0, updated_at: '2026-01-02' }]
    await chat.loadSessions()
    expect(chat.sessions).toHaveLength(1)
    await chat.loadSessions(true)
    expect(chat.sessions.map((session) => session.id)).toEqual(['existing', 'restored'])
    expect(chat.currentSessionId).toBe('existing')
  })
  it('keeps the current session unchanged when the server rejects archiving', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return new Response('', { status: 503 })
      if (String(input) === '/api/settings') return Response.json({})
      if (String(input) === '/api/sessions?archived=all') return Response.json([{ id: 'one', title: 'One', archived: 0 }])
      return Response.json({ messages: [] })
    }))
    const chat = useChatStore()
    await chat.loadSessions()
    await expect(chat.archiveSession('one', true)).rejects.toThrow('archive_failed:503')
    expect(chat.currentSessionId).toBe('one')
    expect(chat.sessions[0].archived).toBe(false)
  })
  it('loads the next session when archiving the current one', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PATCH' || init?.method === 'POST') return Response.json({ success: true })
      if (url === '/api/settings') return Response.json({})
      if (url === '/api/sessions?archived=all') return Response.json([{ id: 'one', title: 'One', archived: 0 }, { id: 'two', title: 'Two', archived: 0 }])
      if (url === '/api/sessions/two') return Response.json({ messages: [{ id: 'm', role: 'user', content: 'next', created_at: '2026-01-01' }] })
      return Response.json({ messages: [] })
    }))
    const chat = useChatStore()
    await chat.loadSessions()
    await chat.archiveSession('one', true)
    expect(chat.currentSessionId).toBe('two')
    expect(chat.archivedSessions.map((s) => s.id)).toEqual(['one'])
    expect(chat.currentMessages[0].id).toBe('m')
    expect(localStorage.getItem('supercrzy:current-session')).toBe('two')
  })
  it.each(['http', 'network'])('retains the session and messages after a %s delete failure', async (failure) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        if (failure === 'network') throw new Error('network unavailable')
        return new Response('', { status: 503 })
      }
      if (String(input) === '/api/settings') return Response.json({})
      if (String(input) === '/api/sessions?archived=all') return Response.json([{ id: 'one', title: 'One', archived: 0 }])
      return Response.json({ messages: [{ id: 'm', role: 'user', content: 'keep', created_at: '2026-01-01' }] })
    }))
    const chat = useChatStore()
    await chat.loadSessions()
    await expect(chat.deleteSession('one')).rejects.toThrow()
    expect(chat.sessions.map((s) => s.id)).toEqual(['one'])
    expect(chat.currentSessionId).toBe('one')
    expect(chat.currentMessages[0].id).toBe('m')
  })
  it('selects and loads an active session after deletion, not an archived one', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'DELETE' || init?.method === 'POST') return Response.json({ success: true })
      if (url === '/api/settings') return Response.json({ currentSessionId: 'one' })
      if (url === '/api/sessions?archived=all') return Response.json([{ id: 'archive', title: 'Archive', archived: 1 }, { id: 'one', title: 'One', archived: 0 }, { id: 'two', title: 'Two', archived: 0 }])
      if (url === '/api/sessions/two') return Response.json({ messages: [{ id: 'next', role: 'user', content: 'next', created_at: '2026-01-01' }] })
      return Response.json({ messages: [] })
    }))
    const chat = useChatStore()
    await chat.loadSessions()
    await chat.deleteSession('one')
    expect(chat.currentSessionId).toBe('two')
    expect(chat.currentMessages[0].id).toBe('next')
    expect(chat.archivedSessions.map((s) => s.id)).toEqual(['archive'])
  })
})
