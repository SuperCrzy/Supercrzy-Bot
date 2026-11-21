import { describe, it, expect } from 'vitest'
import { mergeArtifactRows } from './artifact-merge'

const msg = (artifacts: any[]) => ({ role: 'assistant', deliverySummary: { artifactCount: artifacts.length, artifacts, toolCallCount: 0, turns: 1 } }) as any

describe('mergeArtifactRows', () => {
    it('returns nothing when both sources are empty', () => {
        expect(mergeArtifactRows([], [])).toEqual([])
        expect(mergeArtifactRows(null, null)).toEqual([])
    })

    it('keeps session rows, which carry the id the reveal endpoint needs', () => {
        const rows = mergeArtifactRows([{ id: 'a1', name: 'demo.txt', path: '/w/demo.txt', size: 12 }], [])
        expect(rows).toHaveLength(1)
        expect(rows[0].id).toBe('a1')
    })

    it('includes a fresh artifact that the session list has not caught up to', () => {
        // The turn just finished: SSE delivered deliverySummary, the list refetch
        // has not landed yet. Without this the artifact is invisible for a moment.
        const rows = mergeArtifactRows([], [msg([{ name: 'fresh.txt', path: '/w/fresh.txt' }])])
        expect(rows.map(r => r.name)).toEqual(['fresh.txt'])
        expect(rows[0].id).toBeUndefined()
    })

    it('de-duplicates by path and prefers the row that has an id', () => {
        const rows = mergeArtifactRows(
            [{ id: 'a1', name: 'demo.txt', path: '/w/demo.txt' }],
            [msg([{ name: 'demo.txt', path: '/w/demo.txt' }])],
        )
        expect(rows).toHaveLength(1)
        expect(rows[0].id).toBe('a1')
    })

    it('ignores user messages', () => {
        const user = { role: 'user', deliverySummary: { artifactCount: 1, artifacts: [{ name: 'x', path: '/w/x' }], toolCallCount: 0, turns: 1 } } as any
        expect(mergeArtifactRows([], [user])).toEqual([])
    })

    it('derives a display name from the path when the name is missing', () => {
        const rows = mergeArtifactRows([{ path: '/w/sub/report.md' }], [])
        expect(rows[0].name).toBe('report.md')
    })

    it('keeps the order given: session rows first, then per-turn ones', () => {
        const rows = mergeArtifactRows(
            [{ id: 'a1', name: 'one', path: '/w/one' }],
            [msg([{ name: 'two', path: '/w/two' }])],
        )
        expect(rows.map(r => r.name)).toEqual(['one', 'two'])
    })
})
