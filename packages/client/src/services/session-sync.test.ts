/**
 * session-sync unit tests. HTTP is stubbed at fetch level; crypto uses the real
 * Web Crypto via e2e-crypto's DEK, so the round-trip proves envelope integrity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  pushSession,
  pushAllSessions,
  pullChanges,
  fetchLocalSession,
  listLocalSessions,
  importNewSessions,
  type SyncedSession,
} from './session-sync'
import { createEnvelope, encryptBlob, decryptBlob } from './e2e-crypto'

const sessionFixture: SyncedSession = {
  id: 'sess-1',
  title: '修复 ChatView 折叠',
  model: 'deepseek-chat',
  createdAt: '2026-11-16T10:00:00Z',
  updatedAt: '2026-11-16T11:00:00Z',
  messages: [
    { id: 'm1', role: 'user', content: '先把折叠修了', createdAt: '2026-11-16T10:01:00Z' },
    { id: 'm2', role: 'assistant', content: '已修复 ✓', createdAt: '2026-11-16T10:02:00Z', attachments: { flow: [{ kind: 'tool', tool: { name: 'search' } }], deliverySummary: { text: 'done' } } },
  ],
  artifacts: [{ id: 'a1', name: 'fix.patch', mime: 'text/plain', size: 120, createdAt: '2026-11-16T10:02:00Z' }],
}

const pushLog: Array<{ items: Array<{ scope: string; key: string; blob: string }> }> = []
const store = new Map<string, { blob: string; version: number }>()
let version = 0

beforeEach(() => {
  pushLog.length = 0
  store.clear()
  version = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/sessions?archived=all') {
      return new Response(JSON.stringify([{ id: sessionFixture.id, updated_at: sessionFixture.updatedAt }]))
    }
    if (url === `/api/sessions/${sessionFixture.id}`) {
      return new Response(JSON.stringify(sessionFixture))
    }
    if (url === `/api/sessions/${sessionFixture.id}/artifacts`) {
      return new Response(JSON.stringify({ artifacts: sessionFixture.artifacts }))
    }
    if (url === '/api/auth-sync/push') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { items: Array<{ scope: string; key: string; blob: string; expectedVersion: number }> }
      pushLog.push(body)
      if (body.items.some((item) => item.expectedVersion !== (store.get(`${item.scope}:${item.key}`)?.version ?? 0))) {
        return new Response(JSON.stringify({ error: { code: 'sync_conflict' } }), { status: 409 })
      }
      const results = body.items.map((item) => {
        const next = ++version
        store.set(`${item.scope}:${item.key}`, { blob: item.blob, version: next })
        return { ...item, version: next, deleted: false }
      })
      return new Response(JSON.stringify({ results }))
    }
    if (url === '/api/auth-sync/pull') {
      const items = [...store.entries()].map(([k, v]) => {
        const [scope, key] = k.split(/:(.+)/)
        return { scope, key, blob: v.blob, deleted: false, version: v.version }
      })
      return new Response(JSON.stringify({ items, latestVersion: version }))
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch)
})

describe('session-sync', () => {
  it('decrypts and imports only complete sessions with account-bound requests', async () => {
    const { unlocked } = await createEnvelope('correct horse battery staple')
    await pushSession('sess-1', unlocked.dek, { encryptBlob })
    const originalFetch = vi.mocked(fetch)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/sessions/import') {
        expect((init?.headers as Record<string, string>)['X-Supercrzy-Account']).toBe('owner')
        const body = JSON.parse(String(init?.body))
        expect(body.messages[1].content).toBe('已修复 ✓')
        expect(body.messages[1].attachments).toEqual(sessionFixture.messages[1].attachments)
        return new Response(JSON.stringify({ result: 'created' }), { status: 201 })
      }
      return originalFetch(input, init)
    }))
    expect(await importNewSessions(unlocked.dek, { decryptBlob }, 'owner')).toEqual({ imported: 1, skipped: 0, failures: [] })
  })
  it('remembers acknowledged versions per account and rejects another device’s stale upload', async () => {
    const local = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => local.set(key, value) })
    const { unlocked } = await createEnvelope('correct horse battery staple')
    expect((await pushSession('sess-1', unlocked.dek, { encryptBlob }, 'account-a')).pushed).toBe(3)
    expect((await pushSession('sess-1', unlocked.dek, { encryptBlob }, 'account-a')).pushed).toBe(3)
    const before = store.get('messages:sess-1')
    expect(await pushSession('sess-1', unlocked.dek, { encryptBlob }, 'account-b')).toMatchObject({ pushed: 0, skipped: 'sync_conflict' })
    expect(store.get('messages:sess-1')).toEqual(before)
  })
  it('adopts old cloud versions only when every decrypted item matches', async () => {
    const local = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => local.set(key, value) })
    const { unlocked } = await createEnvelope('correct horse battery staple')
    expect((await pushSession('sess-1', unlocked.dek, { encryptBlob }, 'old-device')).pushed).toBe(3)
    expect((await pushSession('sess-1', unlocked.dek, { encryptBlob, decryptBlob }, 'new-device')).pushed).toBe(3)
    const changed = await encryptBlob(unlocked.dek, { messages: [{ id: 'other', role: 'user', content: 'remote change', createdAt: '' }] })
    store.set('messages:sess-1', { blob: changed, version: ++version })
    expect(await pushSession('sess-1', unlocked.dek, { encryptBlob, decryptBlob }, 'new-device')).toMatchObject({ pushed: 0, skipped: 'sync_conflict' })
    expect(store.get('messages:sess-1')?.blob).toBe(changed)
  })
  it('does not overwrite an older cloud message set when execution metadata differs', async () => {
    const local = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => local.set(key, value) })
    const { unlocked } = await createEnvelope('correct horse battery staple')
    await pushSession('sess-1', unlocked.dek, { encryptBlob }, 'old-device')
    const oldMessages = sessionFixture.messages.map(({ attachments: _attachments, ...message }) => message)
    const oldBlob = await encryptBlob(unlocked.dek, { messages: oldMessages })
    store.set('messages:sess-1', { blob: oldBlob, version: ++version })
    expect(await pushSession('sess-1', unlocked.dek, { encryptBlob, decryptBlob }, 'new-device')).toMatchObject({ pushed: 0, skipped: 'sync_conflict' })
    expect(store.get('messages:sess-1')?.blob).toBe(oldBlob)
  })
  it('reports a failed local session list instead of claiming an empty successful upload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await expect(listLocalSessions()).rejects.toThrow('session list 503')
  })
  it('reports individual read failures and continues uploading other sessions', async () => {
    const originalFetch = vi.mocked(fetch)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/sessions?archived=all') return new Response(JSON.stringify([{ id: 'broken' }, { id: 'sess-1' }]))
      if (String(input) === '/api/sessions/broken') return new Response('', { status: 503 })
      return originalFetch(input, init)
    }))
    const { unlocked } = await createEnvelope('correct horse battery staple')
    const result = await pushAllSessions(unlocked.dek, { encryptBlob })
    expect(result).toEqual({ sessions: 2, items: 3, failures: ['broken: session_read_failed:503'] })
  })
  it('stops the batch immediately on account change instead of treating it as a conflict', async () => {
    const originalFetch = vi.mocked(fetch)
    const paths: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      paths.push(url)
      if (url === '/api/sessions?archived=all') return new Response(JSON.stringify([{ id: 'sess-1' }, { id: 'second' }]))
      if (url === '/api/auth-sync/push') return new Response(JSON.stringify({ error: 'account_changed' }), { status: 409 })
      return originalFetch(input, init)
    }))
    const { unlocked } = await createEnvelope('correct horse battery staple')
    await expect(pushAllSessions(unlocked.dek, { encryptBlob, decryptBlob }, 'owner')).rejects.toThrow('account_changed')
    expect(paths).not.toContain('/api/auth-sync/pull')
    expect(paths).not.toContain('/api/sessions/second')
  })
  it('propagates an account switch during conflict recovery and restore', async () => {
    const originalFetch = vi.mocked(fetch)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/auth-sync/push') return new Response(JSON.stringify({ error: { code: 'sync_conflict' } }), { status: 409 })
      if (String(input) === '/api/auth-sync/pull') return new Response(JSON.stringify({ error: 'account_changed' }), { status: 409 })
      return originalFetch(input, init)
    }))
    const { unlocked } = await createEnvelope('correct horse battery staple')
    await expect(pushSession('sess-1', unlocked.dek, { encryptBlob, decryptBlob }, 'owner')).rejects.toThrow('account_changed')
    await expect(importNewSessions(unlocked.dek, { decryptBlob }, 'owner')).rejects.toThrow('account_changed')
  })
  it('pushes one session as conversations/messages/artifacts items', async () => {
    const { envelope, unlocked } = await createEnvelope('correct horse battery staple')
    expect(envelope.wrappedDek).toBeTruthy()

    const r = await pushSession('sess-1', unlocked.dek, { encryptBlob })
    expect(r.pushed).toBe(3)
    expect(pushLog).toHaveLength(1)
    const scopes = pushLog[0].items.map((i) => i.scope).sort()
    expect(scopes).toEqual(['artifacts', 'conversations', 'messages'])
  })

  it('server cannot read the blobs (zero-knowledge holds end to end)', async () => {
    const { unlocked } = await createEnvelope('correct horse battery staple')
    await pushSession('sess-1', unlocked.dek, { encryptBlob })
    const pushed = pushLog[0].items.find((i) => i.scope === 'messages')!
    const raw = JSON.stringify(pushed)
    expect(raw).not.toContain('折叠')
    expect(raw).not.toContain('已修复')
    expect(raw).not.toContain('search')
  })

  it('pull decrypts back into structured sets', async () => {
    const { unlocked } = await createEnvelope('correct horse battery staple')
    await pushSession('sess-1', unlocked.dek, { encryptBlob })

    const out = await pullChanges(unlocked.dek, { decryptBlob }, 0)
    expect(out.latestVersion).toBe(3)
    expect(out.conversations[0]).toMatchObject({ id: 'sess-1', title: '修复 ChatView 折叠' })
    expect(out.messageSets['sess-1']).toHaveLength(2)
    expect(out.messageSets['sess-1'][0].content).toBe('先把折叠修了')
    expect(out.artifactSets['sess-1'][0].name).toBe('fix.patch')
  })

  it('pushAllSessions aggregates across the local list', async () => {
    const { unlocked } = await createEnvelope('correct horse battery staple')
    const r = await pushAllSessions(unlocked.dek, { encryptBlob })
    expect(r.sessions).toBe(1)
    expect(r.items).toBe(3)
    expect(r.failures).toHaveLength(0)
  })

  it('missing session is skipped, not thrown', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/sessions?archived=all') {
        return new Response(JSON.stringify([{ id: 'sess-ghost', updated_at: '' }]))
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch)
    const { unlocked } = await createEnvelope('correct horse battery staple')
    const r = await pushAllSessions(unlocked.dek, { encryptBlob })
    expect(r.failures[0]).toContain('session_not_found')
  })

  it('fetchLocalSession merges artifacts from the dedicated endpoint', async () => {
    const s = await fetchLocalSession('sess-1')
    expect(s?.artifacts[0].name).toBe('fix.patch')
    void listLocalSessions
    void decryptBlob
  })

  it('normalizes timestamps from the real snake_case session API', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/sessions/sess-1') {
        return new Response(JSON.stringify({
          id: 'sess-1', title: 'Example', model: 'model', created_at: 'created', updated_at: 'updated',
          messages: [{ id: 'm1', role: 'user', content: 'hello', created_at: 'message-created' }],
        }))
      }
      return new Response(JSON.stringify([]))
    }) as unknown as typeof fetch)
    const session = await fetchLocalSession('sess-1')
    expect(session).toMatchObject({ createdAt: 'created', updatedAt: 'updated', artifacts: [], messages: [{ createdAt: 'message-created' }] })
  })

  it('does not upload a session when its artifact list cannot be read', async () => {
    const originalFetch = vi.mocked(fetch)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/sessions/sess-1/artifacts') return new Response('', { status: 503 })
      return originalFetch(input, init)
    }))
    const { unlocked } = await createEnvelope('correct horse battery staple')
    expect(await pushAllSessions(unlocked.dek, { encryptBlob })).toEqual({ sessions: 1, items: 0, failures: ['sess-1: artifacts_read_failed:503'] })
    expect(pushLog).toHaveLength(0)
  })

  it('rejects a malformed artifact response instead of treating it as empty', async () => {
    const originalFetch = vi.mocked(fetch)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/sessions/sess-1/artifacts') return new Response(JSON.stringify({ error: 'unavailable' }))
      return originalFetch(input, init)
    }))
    await expect(fetchLocalSession('sess-1')).rejects.toThrow('invalid_artifacts_response')
  })

  it('includes archived sessions and encrypts their archived state', async () => {
    const originalFetch = vi.mocked(fetch)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/sessions/sess-1') return new Response(JSON.stringify({ ...sessionFixture, archived: 1 }))
      return originalFetch(input, init)
    }))
    const { unlocked } = await createEnvelope('correct horse battery staple')
    expect((await pushAllSessions(unlocked.dek, { encryptBlob })).sessions).toBe(1)
    const item = pushLog[0].items.find((entry) => entry.scope === 'conversations')!
    expect(await decryptBlob(unlocked.dek, item.blob)).toMatchObject({ archived: true })
  })

  it('reads every page using the page cursor and retains deletion markers', async () => {
    const cursors: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const cursor = JSON.parse(String(init?.body)).sinceVersion as number
      cursors.push(cursor)
      return new Response(JSON.stringify(cursor === 0
        ? { items: [{ scope: 'conversations', key: 'one', blob: 'one', deleted: false, version: 1 }], latestVersion: 3, nextCursor: 1, hasMore: true }
        : { items: [{ scope: 'messages', key: 'one', blob: '', deleted: true, version: 3 }], latestVersion: 3, nextCursor: 3, hasMore: false }))
    }) as unknown as typeof fetch)
    const out = await pullChanges({} as CryptoKey, { decryptBlob: async () => ({ title: 'One' }) as never })
    expect(cursors).toEqual([0, 1])
    expect(out.latestVersion).toBe(3)
    expect(out.deletedItems).toEqual([{ scope: 'messages', key: 'one', version: 3 }])
  })

  it('does not advance the cursor when decryption fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      items: [{ scope: 'messages', key: 'one', blob: 'bad', deleted: false, version: 8 }],
      latestVersion: 8, nextCursor: 8, hasMore: false,
    }))) as unknown as typeof fetch)
    const out = await pullChanges({} as CryptoKey, { decryptBlob: async () => { throw new Error('bad key') } }, 5)
    expect(out.decryptFailures).toBe(1)
    expect(out.latestVersion).toBe(5)
  })
  it('does not advance or import when decrypted messages have an invalid shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      items: [{ scope: 'messages', key: 'one', blob: 'ciphertext', deleted: false, version: 8 }],
      latestVersion: 8, nextCursor: 8, hasMore: false,
    }))) as unknown as typeof fetch)
    const crypto = { decryptBlob: async () => ({ messages: 'not-an-array' }) as never }
    const out = await pullChanges({} as CryptoKey, crypto, 5)
    expect(out.decryptFailures).toBe(1)
    expect(out.latestVersion).toBe(5)
    await expect(importNewSessions({} as CryptoKey, crypto, 'owner')).rejects.toThrow('decrypt_failed:1')
  })
  it('rejects a page cursor that skips entries not present in the response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      items: [{ scope: 'messages', key: 'one', blob: 'ciphertext', deleted: false, version: 2 }],
      latestVersion: 10, nextCursor: 10, hasMore: false,
    }))) as unknown as typeof fetch)
    await expect(pullChanges({} as CryptoKey, { decryptBlob: async () => ({ messages: [] }) as never })).rejects.toThrow('Invalid sync cursor')
  })
  it('keeps special session IDs as ordinary keys', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      items: [{ scope: 'messages', key: '__proto__', blob: 'data', deleted: false, version: 1 }],
      latestVersion: 1, nextCursor: 1, hasMore: false,
    }))) as unknown as typeof fetch)
    const messages = [{ id: 'm', role: 'user', content: 'hello', createdAt: 'now' }]
    const out = await pullChanges({} as CryptoKey, { decryptBlob: async () => ({ messages }) as never })
    expect(Object.hasOwn(out.messageSets, '__proto__')).toBe(true)
    expect(out.messageSets['__proto__']).toEqual(messages)
  })
})
