// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useArtifacts, type ArtifactItem } from './useArtifacts'

afterEach(() => vi.unstubAllGlobals())
const item = (id: string, sid = 'a'): ArtifactItem => ({ id, session_id: sid, name: id, path: id, mime: 'text/plain', size: 1, action: 'created', created_at: '' })

describe('desktop session artifacts', () => {
  it('does not replace a new session list with an old response', async () => {
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/a/')
      ? new Promise<Response>((resolve) => { finish = resolve })
      : Promise.resolve(new Response(JSON.stringify([item('new', 'b')])))))
    let sid = 'a'
    const artifacts = useArtifacts({ sessionId: () => sid, t: (x) => x, onWarning: () => {} })
    const old = artifacts.loadArtifacts()
    sid = 'b'
    await artifacts.loadArtifacts()
    finish(new Response(JSON.stringify([item('old')])))
    await old
    expect(artifacts.sessionArtifacts.value.map((a) => a.id)).toEqual(['new'])
  })

  it('preserves a valid list when the server returns an error object', async () => {
    let fail = false
    vi.stubGlobal('fetch', vi.fn(async () => fail
      ? new Response(JSON.stringify({ error: 'failed' }), { status: 500 })
      : new Response(JSON.stringify([item('saved')]))))
    const artifacts = useArtifacts({ sessionId: () => 'a', t: (x) => x, onWarning: () => {} })
    await artifacts.loadArtifacts()
    fail = true
    await artifacts.loadArtifacts()
    expect(artifacts.sessionArtifacts.value.map((a) => a.id)).toEqual(['saved'])
    expect(artifacts.artifactsLoadError.value).toBe(true)
    fail = false
    await artifacts.loadArtifacts()
    expect(artifacts.artifactsLoadError.value).toBe(false)
  })

  it('closes the previous session preview when loading a new session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/content') ? { content: 'old' } : []))))
    let sid = 'a'
    const artifacts = useArtifacts({ sessionId: () => sid, t: (x) => x, onWarning: () => {} })
    await artifacts.loadArtifacts()
    await artifacts.previewArtifactFile(item('old'))
    expect(artifacts.previewArtifact.value?.id).toBe('old')
    sid = 'b'
    await artifacts.loadArtifacts()
    expect(artifacts.previewArtifact.value).toBeNull()
  })

  it('shows the most recently selected preview even if an older request finishes later', async () => {
    let finish!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/old/')
      ? new Promise<Response>((resolve) => { finish = resolve })
      : Promise.resolve(new Response(JSON.stringify({ content: 'new content' })))))
    const artifacts = useArtifacts({ sessionId: () => 'a', t: (x) => x, onWarning: () => {} })
    const old = artifacts.previewArtifactFile(item('old'))
    await artifacts.previewArtifactFile(item('new'))
    finish(new Response(JSON.stringify({ content: 'old content' })))
    await old
    expect(artifacts.previewArtifact.value?.id).toBe('new')
    expect(artifacts.previewArtifact.value?.content).toBe('new content')
  })
})
