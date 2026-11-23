import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from './chat'
import { normalizeDeliverySummary } from '@/utils/delivery'
import { markTurnAborted } from '@/utils/turn-abort'

vi.mock('@/i18n', () => ({ default: () => ({ global: { t: (key: string) => key } }) }))
vi.mock('./app', () => ({ useAppStore: () => ({ resetCtxUsage: () => {} }) }))

beforeEach(() => {
  setActivePinia(createPinia())
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
})
afterEach(() => vi.unstubAllGlobals())

describe('chat session loading', () => {
  it('does not create or select a local session when the server rejects creation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    const chat = useChatStore()
    await expect(chat.createSession('test')).rejects.toThrow('session_create_failed:503')
    expect(chat.sessions).toEqual([])
    expect(chat.currentSessionId).toBeNull()
  })

  it('does not replace a session the user selected while creation was pending', async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const chat = useChatStore()
    const creating = chat.createSession('test')
    chat.currentSessionId = 'selected-in-the-meantime'
    finish(Response.json({}))
    await creating
    expect(chat.currentSessionId).toBe('selected-in-the-meantime')
    expect(chat.sessions).toHaveLength(1)
  })
  it('serializes deletion after an in-flight save and skips later saves of the deleted message', async () => {
    let finishSave!: (response: Response) => void
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(init?.method))
      if (calls.length === 1) return new Promise<Response>(resolve => { finishSave = resolve })
      return Promise.resolve(Response.json({}))
    }))
    const chat = useChatStore()
    chat.messages.set('a', [{ id: 'm', role: 'assistant', content: 'answer', createdAt: '2026-01-01' }])
    const saving = chat.persistMessageById('a', 'm')
    await vi.waitFor(() => expect(calls).toEqual(['POST']))
    const deleting = chat.deleteStoredMessage('a', 'm')
    const lateSave = chat.persistMessageById('a', 'm')
    finishSave(Response.json({}))
    await Promise.all([saving, deleting, lateSave])
    expect(calls).toEqual(['POST', 'DELETE'])
    expect(chat.messages.get('a')).toEqual([])
  })

  it('keeps messages and allows future saves when branch deletion fails', async () => {
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(String(init?.method))
      return init?.method === 'DELETE' ? new Response('', { status: 503 }) : Response.json({})
    }))
    const chat = useChatStore()
    chat.messages.set('a', [{ id: 'm', role: 'assistant', content: 'answer', createdAt: '2026-01-01' }])
    await expect(chat.truncateStoredMessages('a', 'm')).rejects.toThrow('HTTP 503')
    await chat.persistMessageById('a', 'm')
    expect(chat.messages.get('a')?.map(m => m.id)).toEqual(['m'])
    expect(methods).toEqual(['DELETE', 'POST'])
  })

  it('drops late saves for messages removed by branch truncation', async () => {
    let finishDelete!: (response: Response) => void
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(String(init?.method))
      return init?.method === 'DELETE' ? new Promise<Response>(resolve => { finishDelete = resolve }) : Promise.resolve(Response.json({}))
    }))
    const chat = useChatStore()
    chat.messages.set('a', [
      { id: 'old', role: 'user', content: 'keep', createdAt: '2026-01-01' },
      { id: 'branch', role: 'assistant', content: 'discard', createdAt: '2026-01-01' },
    ])
    const deletion = chat.truncateStoredMessages('a', 'branch')
    await vi.waitFor(() => expect(methods).toEqual(['DELETE']))
    const lateSave = chat.persistMessageById('a', 'branch')
    finishDelete(Response.json({}))
    await Promise.all([deletion, lateSave])
    expect(chat.messages.get('a')?.map(m => m.id)).toEqual(['old'])
    expect(methods).toEqual(['DELETE'])
  })

  it('saves the finished response even after a newer message is appended', async () => {
    const saved: any[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      saved.push(JSON.parse(String(init?.body)))
      return Response.json({})
    }))
    const chat = useChatStore()
    chat.messages.set('a', [
      { id: 'first', role: 'assistant', content: '完整回答', createdAt: '2026-01-01', flow: [{ kind: 'text', text: '完整回答' }] },
      { id: 'next', role: 'user', content: '下一个问题', createdAt: '2026-01-01' },
    ])
    await chat.persistMessageById('a', 'first')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ id: 'first', content: '完整回答', attachments: { flow: [{ kind: 'text', text: '完整回答' }] } })
    await chat.persistMessageById('a', 'deleted')
    expect(saved).toHaveLength(1)
  })

  it('retains a stopped plain-text reply and its original attachments after reload', async () => {
    let saved: any
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { saved = JSON.parse(String(init.body)); return Response.json({}) }
      if (String(input) === '/api/sessions/a') return Response.json({ messages: [{ ...saved, attachments: JSON.stringify(saved.attachments), created_at: '2026-01-01' }] })
      return Response.json({})
    }))
    const chat = useChatStore()
    const attachments = [{ id: 'file-1', name: 'note.txt', url: '/note.txt', type: 'text/plain', size: 3 }]
    chat.messages.set('a', [{ id: 'm', role: 'assistant', content: '部分回答', createdAt: '2026-01-01', attachments }])
    markTurnAborted(chat.messages.get('a')!, Date.now(), '后台任务可能仍在执行')
    await chat.persistLastMessage('a')
    expect(saved.attachments).toMatchObject({ isAborted: true, attachments })
    await chat.loadMessages('a')
    expect(chat.messages.get('a')?.[0]).toMatchObject({ content: [{ type: 'text', text: '部分回答' }], isAborted: true, stopReason: { reason: 'user_stopped', message: '后台任务可能仍在执行' } })
  })

  it('retains a stopped task outcome and checkpoint after saving and reloading', async () => {
    let saved: any
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { saved = JSON.parse(String(init.body)); return Response.json({}) }
      if (String(input) === '/api/sessions/a') return Response.json({ messages: [{ ...saved, created_at: '2026-01-01' }] })
      return Response.json({})
    }))
    const chat = useChatStore()
    const deliverySummary = normalizeDeliverySummary({ status: 'cancelled', summary: '已按你的要求停止', checkpointId: 'checkpoint-1', canResume: true, changedFiles: [{ name: 'a.ts', path: '/a.ts' }] })
    chat.messages.set('a', [{ id: 'm', role: 'assistant', content: '部分结果', createdAt: '2026-01-01', deliverySummary }])
    await chat.persistLastMessage('a')
    await chat.loadMessages('a')
    expect(chat.messages.get('a')?.[0].deliverySummary).toEqual(deliverySummary)
    expect(chat.messages.get('a')?.[0].isAborted).toBe(true)
  })

  it('retains delivery summary without flow nodes after saving and reloading', async () => {
    let saved: any
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { saved = JSON.parse(String(init.body)); return Response.json({}) }
      if (String(input) === '/api/sessions/a') return Response.json({ messages: [{ ...saved, created_at: '2026-01-01' }] })
      return Response.json({})
    }))
    const chat = useChatStore()
    const deliverySummary = { summary: '工作已完成', artifactCount: 1, artifacts: [{ name: 'report.txt', path: '/report.txt', mime: 'text/plain' }], toolCallCount: 0, turns: 1 }
    chat.messages.set('a', [{ id: 'm', role: 'assistant', content: '结果', createdAt: '2026-01-01', deliverySummary }])
    await chat.persistLastMessage('a')
    await chat.loadMessages('a')
    expect(chat.messages.get('a')?.[0].deliverySummary).toEqual(deliverySummary)
  })

  it('clears a save warning when its message is removed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const chat = useChatStore()
      await chat.addMessage('a', { id: 'm', role: 'user', content: 'draft', createdAt: '2026-01-01' })
      chat.removeMessage('a', 'm')
      expect(chat.unsavedMessages.has('a')).toBe(false)
    } finally { errorLog.mockRestore() }
  })

  it('retries a failed user message before saving the assistant reply', async () => {
    let fail = true
    const attempts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const id = JSON.parse(String(init?.body)).id
      attempts.push(id)
      return fail ? new Response('', { status: 503 }) : Response.json({})
    }))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const chat = useChatStore()
      await chat.addMessage('a', { id: 'user', role: 'user', content: 'question', createdAt: '2026-01-01' })
      await chat.addMessage('a', { id: 'assistant', role: 'assistant', content: 'answer', createdAt: '2026-01-01' })
      expect(attempts).toEqual(['user'])
      expect(chat.unsavedMessages.get('a')).toEqual(['user', 'assistant'])
      fail = false
      await chat.retryUnsavedMessages('a')
      expect(attempts).toEqual(['user', 'user', 'assistant'])
      expect(chat.unsavedMessages.has('a')).toBe(false)
    } finally { errorLog.mockRestore() }
  })

  it('keeps a failed message visible and clears its save warning after retry', async () => {
    let fail = true
    vi.stubGlobal('fetch', vi.fn(async () => fail ? new Response('', { status: 503 }) : Response.json({})))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const chat = useChatStore()
      await chat.addMessage('a', { id: 'm', role: 'user', content: 'keep me', createdAt: '2026-01-01' })
      expect(chat.messages.get('a')?.[0].content).toBe('keep me')
      expect(chat.unsavedMessages.get('a')).toEqual(['m'])
      fail = false
      await chat.retryUnsavedMessages('a')
      expect(chat.unsavedMessages.has('a')).toBe(false)
    } finally { errorLog.mockRestore() }
  })

  it('runs a forced refresh after an already-running load completes', async () => {
    let finish!: (response: Response) => void
    let listCalls = 0
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/sessions?archived=all') {
        listCalls++
        return listCalls === 1 ? new Promise<Response>((resolve) => { finish = resolve }) : Promise.resolve(Response.json([{ id: 'new', title: 'New' }]))
      }
      if (String(input) === '/api/settings') return Promise.resolve(Response.json({}))
      return Promise.resolve(Response.json({ messages: [] }))
    }))
    const chat = useChatStore()
    const first = chat.loadSessions()
    await vi.waitFor(() => expect(listCalls).toBe(1))
    const refresh = chat.loadSessions(true)
    finish(Response.json([]))
    await Promise.all([first, refresh])
    expect(listCalls).toBe(2)
    expect(chat.sessions.map(s => s.id)).toEqual(['new'])
  })

  it('persists rapid session choices in order', async () => {
    let finish!: (response: Response) => void
    const saved: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/settings' && init?.method === 'POST') {
        saved.push(JSON.parse(String(init.body)).currentSessionId)
        if (saved.length === 1) return new Promise<Response>((resolve) => { finish = resolve })
      }
      return Promise.resolve(Response.json({ messages: [] }))
    }))
    const chat = useChatStore()
    await Promise.all([chat.selectSession('a'), chat.selectSession('b')])
    await vi.waitFor(() => expect(saved).toEqual(['a']))
    finish(Response.json({}))
    await vi.waitFor(() => expect(saved).toEqual(['a', 'b']))
    expect(chat.currentSessionId).toBe('b')
  })

  it('does not replace a user selection with settings returned after it', async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/settings' && !init?.method) return new Promise<Response>((resolve) => { finish = resolve })
      if (url === '/api/sessions?archived=all') return Promise.resolve(Response.json([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]))
      return Promise.resolve(Response.json({ messages: [] }))
    }))
    const chat = useChatStore()
    const loading = chat.loadSessions()
    await chat.selectSession('b')
    finish(Response.json({ currentSessionId: 'a' }))
    await loading
    expect(chat.currentSessionId).toBe('b')
  })

  it('shares concurrent initial session loads from the layout and chat view', async () => {
    let finish!: (response: Response) => void
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/settings') return new Promise<Response>((resolve) => { finish = resolve })
      if (String(input) === '/api/sessions?archived=all') return Promise.resolve(Response.json([]))
      return Promise.resolve(Response.json({ messages: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const chat = useChatStore()
    const first = chat.loadSessions()
    const second = chat.loadSessions()
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/settings')).toHaveLength(1)
    finish(Response.json({}))
    await Promise.all([first, second])
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/sessions?archived=all')).toHaveLength(1)
  })

  it('exposes history loading and failure states until a successful retry', async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const chat = useChatStore()
      const pending = chat.loadMessages('a')
      expect(chat.messageLoadState.get('a')).toBe('loading')
      finish(new Response('', { status: 503 }))
      await pending
      expect(chat.messageLoadState.get('a')).toBe('error')
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ messages: [] })))
      await chat.loadMessages('a')
      expect(chat.messageLoadState.has('a')).toBe(false)
    } finally { errorLog.mockRestore() }
  })

  it('does not replace messages added while a history request is in flight', async () => {
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/sessions/a' && !init?.method) return new Promise<Response>((resolve) => { finish = resolve })
      return Promise.resolve(Response.json({}))
    }))
    const chat = useChatStore()
    chat.messages.set('a', [])
    const load = chat.loadMessages('a')
    await chat.addMessage('a', { id: 'new', role: 'user', content: 'new message', createdAt: '2026-01-01' })
    finish(Response.json({ messages: [{ id: 'old', role: 'assistant', content: 'history', created_at: '2026-01-01' }, { id: 'new', role: 'user', content: 'server copy', created_at: '2026-01-01' }] }))
    await load
    expect(chat.messages.get('a')?.map(m => m.id)).toEqual(['old', 'new'])
    expect(chat.messages.get('a')?.[1].content).toBe('new message')
  })

  it('restores an interrupted partial answer and its notice after reloading', async () => {
    let saved: any
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { saved = JSON.parse(String(init.body)); return Response.json({}) }
      if (String(input) === '/api/sessions/a') return Response.json({ messages: [{ ...saved, created_at: '2026-01-01', attachments: JSON.stringify(saved.attachments) }] })
      return Response.json({})
    }))
    const chat = useChatStore()
    chat.messages.set('a', [{ id: 'm', role: 'assistant', content: 'partial answer', createdAt: '2026-01-01', stopReason: { reason: 'connection_interrupted', message: '连接中断' } }])
    await chat.persistLastMessage('a')
    expect(saved.attachments.stopReason.reason).toBe('connection_interrupted')
    await chat.loadMessages('a')
    expect(chat.messages.get('a')?.[0].stopReason).toEqual({ reason: 'connection_interrupted', message: '连接中断' })
  })

  it('preserves XML text and avoids nesting attachment wrappers on repeated saves', async () => {
    let saved: any
    const xml = '```xml\n<settings><theme>dark</theme></settings>\n```'
    const attachment = { id: 'file', name: 'file.txt', type: 'text/plain', size: 1, url: '/file' }
    const meta = { attachments: [attachment], flow: [{ id: 'text', kind: 'text', text: xml }], stopReason: { reason: 'interrupted', message: 'stopped' } }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') { saved = JSON.parse(String(init.body)); return Response.json({}) }
      if (String(input) === '/api/sessions/a') return Response.json({ messages: [{ id: 'm', role: 'assistant', content: xml, created_at: '2026-01-01', attachments: meta }] })
      return Response.json({})
    }))
    const chat = useChatStore()
    await chat.loadMessages('a')
    expect(chat.messages.get('a')?.[0].flow?.find(n => n.kind === 'text')).toMatchObject({ text: xml })
    await chat.persistLastMessage('a')
    expect(saved.attachments.attachments).toEqual([attachment])
    expect(saved.attachments.stopReason.reason).toBe('interrupted')
  })

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
