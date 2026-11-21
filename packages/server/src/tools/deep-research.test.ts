/**
 * The guard that matters here is negative: a report with no sources must not
 * come back at all. Without it the model writes a convincing, sourced-looking
 * document from memory, which the user has no way to tell from real research.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runDeepResearch = vi.fn()
vi.mock('../services/deep-research', () => ({ runDeepResearch: (...a: any[]) => runDeepResearch(...a) }))

async function getTool() {
    const mod = await import('./deep-research')
    return (mod as any).default
}

describe('deep_research output guard', () => {
    beforeEach(() => runDeepResearch.mockReset())

    it('refuses to return a report when no source was visited', async () => {
        runDeepResearch.mockResolvedValue({ learnings: [], visitedUrls: [], report: '看起来很正规的报告正文' })
        const tool = await getTool()
        const out = await tool.execute({ query: 'probe' }, {} as any)
        expect(out).toContain('未取得任何来源')
        expect(out).not.toContain('看起来很正规的报告正文')
    })

    it('returns the report when at least one source was visited', async () => {
        runDeepResearch.mockResolvedValue({
            learnings: ['a'], visitedUrls: ['https://example.com'], report: 'REAL-REPORT-BODY',
        })
        const tool = await getTool()
        const out = await tool.execute({ query: 'probe' }, {} as any)
        expect(out).toContain('REAL-REPORT-BODY')
        expect(JSON.parse(out).visitedUrls).toHaveLength(1)
    })
})
