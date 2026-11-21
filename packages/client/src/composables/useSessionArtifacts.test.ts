// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { useSessionArtifacts } from './useSessionArtifacts'

const ROWS = [
    { id: 'a1', session_id: 's1', name: 'demo.txt', path: '/w/demo.txt', mime: 'text/plain', size: 20 },
    { id: 'a2', session_id: 's1', name: 'report.md', path: '/w/report.md', mime: 'text/markdown', size: 2048 },
]

const originalFetch = global.fetch

beforeEach(() => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify(ROWS), { status: 200 })) as any
})
afterEach(() => { global.fetch = originalFetch })

/** Run the composable inside a scope; watchers and effect cleanup need one. */
function setup(overrides: Partial<Parameters<typeof useSessionArtifacts>[0]> = {}) {
    const scope = effectScope()
    const api = scope.run(() => useSessionArtifacts({
        sessionId: () => 's1',
        visible: () => true,
        activeTab: () => 'files',
        messages: () => [],
        preview: () => {},
        openDir: () => {},
        ...overrides,
    }))!
    return { api, scope }
}

describe('useSessionArtifacts', () => {
    it('loads the session artifact list and exposes it to the group', async () => {
        const { api, scope } = setup()
        await nextTick(); await nextTick()
        // fetch resolves on a microtask; give the promise chain a turn.
        await new Promise(r => setTimeout(r, 20))
        expect(api.sessionArtifacts.value).toHaveLength(2)
        expect(api.artifactFiles.value.map((a: any) => a.name)).toEqual(['demo.txt', 'report.md'])
        scope.stop()
    })

    it('stays empty (and does not fetch) when no session is selected', async () => {
        const calls = (global.fetch as any).mock.calls.length
        const { api, scope } = setup({ sessionId: () => null })
        await new Promise(r => setTimeout(r, 20))
        expect(api.sessionArtifacts.value).toHaveLength(0)
        expect((global.fetch as any).mock.calls.length).toBe(calls)
        scope.stop()
    })

    it('survives a failed request without throwing', async () => {
        global.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as any
        const { api, scope } = setup()
        await new Promise(r => setTimeout(r, 20))
        expect(api.sessionArtifacts.value).toHaveLength(0)
        scope.stop()
    })

    it('merges deliverySummary rows even when the list fetch fails', async () => {
        global.fetch = vi.fn(async () => { throw new Error('offline') }) as any
        const { api, scope } = setup({
            messages: () => [{ role: 'assistant', deliverySummary: { artifactCount: 1, artifacts: [{ name: 'fresh.txt', path: '/w/fresh.txt' }], toolCallCount: 1, turns: 1 } }],
        })
        await new Promise(r => setTimeout(r, 20))
        expect(api.artifactFiles.value.map((a: any) => a.name)).toEqual(['fresh.txt'])
        scope.stop()
    })

    it('opens the context menu at the pointer and closes it', () => {
        const { api, scope } = setup()
        api.openArtifactMenu({ clientX: 100, clientY: 200 } as any, ROWS[0] as any)
        expect(api.artifactMenu.open).toBe(true)
        expect(api.artifactMenu.item?.path).toBe('/w/demo.txt')
        api.closeArtifactMenu()
        expect(api.artifactMenu.open).toBe(false)
        scope.stop()
    })
})
