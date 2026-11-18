/**
 * Session sync (M8 P2). Bridges the local BOT server's session store to the
 * IdP's zero-knowledge sync blob store.
 *
 * Data flow (push):  GET /api/sessions(+/:id,/artifacts) → encrypt with the
 * unlocked DEK → POST /api/auth-sync/push (scope=conversations/messages/artifacts)
 * Data flow (pull):  POST /api/auth-sync/pull {sinceVersion} → decrypt → merge
 *
 * Key convention (must stay in lockstep with supercrzy-auth services/sync.ts):
 *   conversations → key = sessionId        (title/model/timestamps)
 *   messages      → key = `${sessionId}`   (whole message array per session —
 *                                            one item, not per-message, keeps
 *                                            ordering atomic under LWW)
 *   artifacts     → key = artifactId       (metadata only; file bytes stay local)
 */

export interface SyncedSession {
  id: string
  title: string
  model: string
  createdAt: string
  updatedAt: string
  archived?: boolean | number
  messages: Array<{
    id: string
    role: string
    content: string
    createdAt: string
    attachments?: unknown
  }>
  artifacts: Array<{
    id: string
    name: string
    mime: string
    size: number
    createdAt: string
  }>
}

export interface SyncDeps {
  /** Decrypt-capable DEK (from e2e-crypto unlock). */
  dek: CryptoKey
  encryptBlob: (dek: CryptoKey, payload: unknown) => Promise<string>
  decryptBlob: <T>(dek: CryptoKey, blob: string) => Promise<T>
}

async function syncErrorCode(res: Response): Promise<string> {
  const body = await res.clone().json().catch(() => ({})) as { error?: string | { code?: string } }
  if (res.status === 401) return 'not_signed_in'
  return typeof body.error === 'string' ? body.error : body.error?.code || ''
}

function isAccountBoundaryError(code: string): boolean {
  return code === 'account_changed' || code === 'not_signed_in' || code === 'account_header_required'
}

/** Fetch one session (with messages and artifacts) from the local server. */
export async function fetchLocalSession(sessionId: string): Promise<SyncedSession | null> {
  const encodedId = encodeURIComponent(sessionId)
  const res = await fetch(`/api/sessions/${encodedId}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`session_read_failed:${res.status}`)
  const raw = (await res.json()) as SyncedSession & { created_at?: string; updated_at?: string }
  const session: SyncedSession = {
    ...raw,
    createdAt: raw.createdAt ?? raw.created_at ?? '',
    updatedAt: raw.updatedAt ?? raw.updated_at ?? '',
    messages: (raw.messages ?? []).map((message) => {
      const row = message as typeof message & { created_at?: string }
      return { ...row, createdAt: row.createdAt ?? row.created_at ?? '' }
    }),
  }
  const artRes = await fetch(`/api/sessions/${encodedId}/artifacts`)
  if (!artRes.ok) throw new Error(`artifacts_read_failed:${artRes.status}`)
  const body = (await artRes.json()) as { artifacts?: unknown } | unknown[] | null
  const artifacts = Array.isArray(body) ? body : body?.artifacts
  if (!Array.isArray(artifacts)) throw new Error('invalid_artifacts_response')
  session.artifacts = artifacts as SyncedSession['artifacts']
  return session
}

/** List local session ids (most recent first). */
export async function listLocalSessions(): Promise<Array<{ id: string; updatedAt: string }>> {
  const res = await fetch('/api/sessions?archived=all')
  if (!res.ok) throw new Error(`session list ${res.status}`)
  const rows = (await res.json()) as Array<{ id: string; updated_at?: string; updatedAt?: string }>
  return rows.map((r) => ({ id: r.id, updatedAt: r.updated_at ?? r.updatedAt ?? '' }))
}

/**
 * Push one session as three sync items. Overwrites are intentional: the whole
 * message ordering is atomic. Previously acknowledged versions are used to
 * prevent silently overwriting a different device's newer data.
 */
export async function pushSession(
  sessionId: string,
  dek: CryptoKey,
  crypto_: Pick<SyncDeps, 'encryptBlob'> & Partial<Pick<SyncDeps, 'decryptBlob'>>,
  expectedAccountId?: string,
): Promise<{ pushed: number; skipped?: string }> {
  const session = await fetchLocalSession(sessionId)
  if (!session) return { pushed: 0, skipped: 'session_not_found' }
  const storageKey = expectedAccountId ? `supercrzy:sync-versions:${expectedAccountId}` : ''
  let versions: Record<string, number> = {}
  try { if (storageKey) versions = JSON.parse(localStorage.getItem(storageKey) || '{}') as Record<string, number> } catch { versions = {} }
  const items: Array<{ scope: string; key: string; blob: string; expectedVersion?: number }> = [
    {
      scope: 'conversations',
      key: session.id,
      blob: await crypto_.encryptBlob(dek, {
        title: session.title,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        ...(session.archived === true || session.archived === 1 ? { archived: true } : {}),
      }),
    },
    {
      scope: 'messages',
      key: session.id,
      blob: await crypto_.encryptBlob(dek, {
        messages: session.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
          ...(m.attachments != null && !(Array.isArray(m.attachments) && m.attachments.length === 0)
            ? { attachments: m.attachments } : {}),
        })),
      }),
    },
  ]
  if (session.artifacts.length > 0) {
    items.push({
      scope: 'artifacts',
      key: session.id,
      blob: await crypto_.encryptBlob(dek, { artifacts: session.artifacts }),
    })
  }
  for (const item of items) {
    const version = versions[JSON.stringify([item.scope, item.key])]
    item.expectedVersion = Number.isSafeInteger(version) && version >= 0 ? version : 0
  }
  const headers = { 'Content-Type': 'application/json', ...(expectedAccountId ? { 'X-Supercrzy-Account': expectedAccountId } : {}) }
  const push = () => fetch('/api/auth-sync/push', { method: 'POST', headers, body: JSON.stringify({ items }) })
  let res = await push()
  const initialError = !res.ok ? await syncErrorCode(res) : ''
  if (isAccountBoundaryError(initialError)) throw new Error(initialError)
  // Existing users may have uploaded before this device recorded base versions.
  // Adopt cloud versions only when every existing item decrypts to identical
  // content; a second CAS still protects against concurrent changes.
  if (res.status === 409 && initialError === 'sync_conflict' && crypto_.decryptBlob && expectedAccountId) {
    try {
      const found = new Map<string, { blob: string; deleted: boolean; version: number }>()
      let cursor = 0
      for (;;) {
        const page = await fetch('/api/auth-sync/pull', { method: 'POST', headers, body: JSON.stringify({ sinceVersion: cursor, limit: 1000 }) })
        if (!page.ok) {
          const error = await syncErrorCode(page)
          throw new Error(isAccountBoundaryError(error) ? error : 'pull_failed')
        }
        const data = await page.json() as { items: Array<{ scope: string; key: string; blob: string; deleted: boolean; version: number }>; nextCursor: number; hasMore: boolean }
        for (const row of data.items) if (row.key === session.id && items.some((item) => item.scope === row.scope)) found.set(row.scope, row)
        if (!data.hasMore) break
        if (!Number.isSafeInteger(data.nextCursor) || data.nextCursor <= cursor) throw new Error('invalid_cursor')
        cursor = data.nextCursor
      }
      for (const item of items) {
        const cloud = found.get(item.scope)
        if (!cloud) { item.expectedVersion = 0; continue }
        if (cloud.deleted || !Number.isSafeInteger(cloud.version) || cloud.version <= 0) throw new Error('sync_conflict')
        const localContent = await crypto_.decryptBlob(dek, item.blob)
        const cloudContent = await crypto_.decryptBlob(dek, cloud.blob)
        if (JSON.stringify(localContent) !== JSON.stringify(cloudContent)) throw new Error('sync_conflict')
        item.expectedVersion = cloud.version
      }
      res = await push()
    } catch (error) {
      if (error instanceof Error && isAccountBoundaryError(error.message)) throw error
      return { pushed: 0, skipped: error instanceof Error && error.message === 'pull_failed' ? 'sync_recovery_failed' : 'sync_conflict' }
    }
  }
  if (!res.ok) {
    const error = await syncErrorCode(res)
    if (isAccountBoundaryError(error)) throw new Error(error)
    return { pushed: 0, skipped: error || `push ${res.status}` }
  }
  const body = (await res.json()) as { results?: Array<{ scope: string; key: string; version: number }> }
  if (!Array.isArray(body.results) || body.results.length !== items.length || items.some((item) => !body.results!.some((result) => result.scope === item.scope && result.key === item.key && Number.isSafeInteger(result.version) && result.version > 0))) {
    throw new Error('invalid_sync_response')
  }
  for (const result of body.results) versions[JSON.stringify([result.scope, result.key])] = result.version
  if (storageKey) localStorage.setItem(storageKey, JSON.stringify(versions))
  return { pushed: items.length }
}

/** Push every local session (bootstraps a fresh account). */
export async function pushAllSessions(
  dek: CryptoKey,
  crypto_: Pick<SyncDeps, 'encryptBlob'> & Partial<Pick<SyncDeps, 'decryptBlob'>>,
  expectedAccountId?: string,
): Promise<{ sessions: number; items: number; failures: string[] }> {
  const sessions = await listLocalSessions()
  const failures: string[] = []
  let items = 0
  for (const s of sessions) {
    try {
      const r = await pushSession(s.id, dek, crypto_, expectedAccountId)
      if (r.pushed > 0) items += r.pushed
      else failures.push(`${s.id}: ${r.skipped}`)
    } catch (error) {
      if (error instanceof Error && isAccountBoundaryError(error.message)) throw error
      failures.push(`${s.id}: ${error instanceof Error ? error.message : 'sync_failed'}`)
    }
  }
  return { sessions: sessions.length, items, failures }
}

/** Pull ciphertext changes since a version and decrypt them. */
export async function pullChanges(
  dek: CryptoKey,
  crypto_: Pick<SyncDeps, 'decryptBlob'>,
  sinceVersion = 0,
  expectedAccountId?: string,
): Promise<{
  latestVersion: number
  decryptFailures: number
  deletedItems: Array<{ scope: string; key: string; version: number }>
  conversations: Array<Record<string, unknown> & { id: string; title: string }>
  messageSets: Record<string, SyncedSession['messages']>
  artifactSets: Record<string, Array<{ id: string; name: string }>>
}> {
  const out = {
    latestVersion: sinceVersion,
    decryptFailures: 0,
    deletedItems: [] as Array<{ scope: string; key: string; version: number }>,
    conversations: [] as Array<Record<string, unknown> & { id: string; title: string }>,
    messageSets: Object.create(null) as Record<string, SyncedSession['messages']>,
    artifactSets: Object.create(null) as Record<string, Array<{ id: string; name: string }>>,
  }
  let cursor = sinceVersion
  let hasMore = true
  while (hasMore) {
    const res = await fetch('/api/auth-sync/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(expectedAccountId ? { 'X-Supercrzy-Account': expectedAccountId } : {}) },
      body: JSON.stringify({ sinceVersion: cursor, limit: 1000 }),
    })
    if (!res.ok) {
      const error = await syncErrorCode(res)
      throw new Error(isAccountBoundaryError(error) ? error : `pull ${res.status}`)
    }
    const body = (await res.json()) as {
      items: Array<{ scope: string; key: string; blob: string; deleted: boolean; version: number }>
      latestVersion: number
      nextCursor?: number
      hasMore?: boolean
    }
    if (!Array.isArray(body.items) || !Number.isSafeInteger(body.latestVersion) || body.latestVersion < 0 || (body.hasMore !== undefined && typeof body.hasMore !== 'boolean')) throw new Error('Invalid sync page')
    let lastVersion = cursor
    for (const item of body.items) {
      if (!item || typeof item.scope !== 'string' || typeof item.key !== 'string' || !item.key || typeof item.blob !== 'string' || typeof item.deleted !== 'boolean' || !Number.isSafeInteger(item.version) || item.version <= lastVersion) throw new Error('Invalid sync page')
      lastVersion = item.version
    }
    const nextCursor = body.nextCursor ?? lastVersion
    if (!Number.isSafeInteger(nextCursor) || nextCursor !== lastVersion) throw new Error('Invalid sync cursor')
    hasMore = body.hasMore ?? (body.items.length === 1000 && body.latestVersion > nextCursor)
    if (nextCursor < cursor || (hasMore && nextCursor <= cursor)) throw new Error('Invalid sync cursor')
    for (const item of body.items) {
      if (item.deleted) {
        out.deletedItems.push({ scope: item.scope, key: item.key, version: item.version })
        continue
      }
      try {
        if (item.scope === 'conversations') {
          const d = await crypto_.decryptBlob<Record<string, unknown> & { title: string }>(dek, item.blob)
          if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.title !== 'string' || !d.title) throw new Error('invalid_sync_item')
          out.conversations.push({ ...d, id: item.key })
        } else if (item.scope === 'messages') {
          const d = await crypto_.decryptBlob<{ messages: SyncedSession['messages'] }>(dek, item.blob)
          if (!d || !Array.isArray(d.messages) || d.messages.length > 10_000 || d.messages.some((m) => !m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id || !['user', 'assistant', 'system'].includes(m.role) || typeof m.content !== 'string' || typeof m.createdAt !== 'string' || !m.createdAt)) throw new Error('invalid_sync_item')
          out.messageSets[item.key] = d.messages
        } else if (item.scope === 'artifacts') {
          const d = await crypto_.decryptBlob<{ artifacts: Array<{ id: string; name: string }> }>(dek, item.blob)
          if (!d || !Array.isArray(d.artifacts) || d.artifacts.some((a) => !a || typeof a !== 'object' || typeof a.id !== 'string' || typeof a.name !== 'string')) throw new Error('invalid_sync_item')
          out.artifactSets[item.key] = d.artifacts
        }
      } catch {
        // Retain the starting cursor so failed items can be retried.
        out.decryptFailures += 1
      }
    }
    cursor = nextCursor
  }
  // A caller must retry the entire pull if any encrypted item failed: advancing
  // a durable cursor past it would silently discard that item.
  out.latestVersion = out.decryptFailures ? sinceVersion : cursor
  return out
}

/** Restore only complete, locally absent conversations; never overwrite local data. */
export async function importNewSessions(dek: CryptoKey, crypto_: Pick<SyncDeps, 'decryptBlob'>, accountId: string): Promise<{ imported: number; skipped: number; failures: string[] }> {
  const cloud = await pullChanges(dek, crypto_, 0, accountId)
  if (cloud.decryptFailures) throw new Error(`decrypt_failed:${cloud.decryptFailures}`)
  let imported = 0
  let skipped = 0
  const failures: string[] = []
  for (const session of cloud.conversations) {
    if (!Object.prototype.hasOwnProperty.call(cloud.messageSets, session.id)) { failures.push(`${session.id}: missing_messages`); continue }
    const response = await fetch('/api/sessions/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Supercrzy-Account': accountId },
      body: JSON.stringify({ ...session, messages: cloud.messageSets[session.id] }),
    })
    const body = await response.json().catch(() => ({})) as { result?: string; error?: string }
    if (response.status === 201 && body.result === 'created') imported++
    else if (response.status === 409 && body.result === 'exists') skipped++
    else if (body.error === 'account_changed' || body.error === 'not_signed_in') throw new Error(body.error)
    else failures.push(`${session.id}: ${body.error || `import ${response.status}`}`)
  }
  return { imported, skipped, failures }
}

/** IdP-side cursor status (per-account latest version). */
export async function syncStatus(): Promise<{ latestVersion?: number } | null> {
  const res = await fetch('/api/auth-sync/status')
  if (!res.ok) return null
  return res.json()
}
