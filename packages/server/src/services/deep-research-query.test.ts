/**
 * Locks the fix for a failure that looked like success: with a small breadth the
 * query generator drifted to generic phrasing, the crawl visited the company
 * homepage instead of the news, and the report opened by saying the topic was
 * never covered — while relevant results were one search away.
 *
 * The invariant: on the first round, the user's own query is always searched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const searchCalls: string[] = []

vi.mock('./tools', () => ({
    webSearchChain: vi.fn(async (q: string) => {
        searchCalls.push(q)
        return {
            engine: 'mock',
            results: [{ title: `T-${q}`, url: `https://example.com/${encodeURIComponent(q)}`, description: 'd', date: '' }],
        }
    }),
    runExhaustiveSearch: vi.fn(async () => ({ engine: 'mock', results: [], engines: [] })),
}))

const originalFetch = global.fetch
let tmpDb: string

beforeEach(() => {
    searchCalls.length = 0
    tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dr-')), 'test.db')
    process.env.DB_PATH = tmpDb
    vi.resetModules()

    // Every LLM call gets a payload that satisfies all three consumers:
    // queries for generateSerpQueries, learnings for processSerpResult, and
    // report for the final write-up.
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
        choices: [{
            message: {
                content: JSON.stringify({
                    queries: [{ query: 'Anthropic', researchGoal: 'generic goal' }],
                    learnings: ['a learning'],
                    followUpQuestions: ['follow up'],
                    report: 'REPORT-BODY',
                }),
            },
        }],
    }), { status: 200 })) as any
})

afterEach(() => { global.fetch = originalFetch })

async function run(query: string) {
    const db = await import('./database')
    db.initDatabase()
    db.getDB().prepare("INSERT INTO settings(key,value) VALUES('apiKey','test-key') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run()
    const { runDeepResearch } = await import('./deep-research')
    return runDeepResearch({ query, breadth: 2, depth: 1 })
}

describe('deep research first-round query', () => {
    it("searches the user's own wording even when the model produced generic queries", async () => {
        await run('Anthropic IPO 估值')
        expect(searchCalls[0]).toBe('Anthropic IPO 估值')
    })

    it('spends the first query slot on the user wording, not on a generated one', async () => {
        await run('Anthropic IPO 估值')
        // depth=1 has a one-query budget, so whichever query lands first is the
        // only one that runs. It has to be the user's, otherwise the whole round
        // is spent on the model's guess.
        expect(searchCalls).toHaveLength(1)
        expect(searchCalls[0]).toBe('Anthropic IPO 估值')
    })

    it('does not duplicate the original query when the model returns it verbatim', async () => {
        global.fetch = vi.fn(async () => new Response(JSON.stringify({
            choices: [{
                message: {
                    content: JSON.stringify({
                        queries: [{ query: 'same query', researchGoal: 'g' }],
                        learnings: ['l'], followUpQuestions: [], report: 'R',
                    }),
                },
            }],
        }), { status: 200 })) as any
        await run('same query')
        expect(searchCalls.filter(q => q === 'same query')).toHaveLength(1)
    })
})
