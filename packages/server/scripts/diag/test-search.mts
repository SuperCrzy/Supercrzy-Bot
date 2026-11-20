import { initDatabase } from '../../src/services/database.js'
import { runSearchChain } from '../../src/services/search-providers.js'
initDatabase()
const q = process.argv[2] || 'Anthropic IPO 估值'
const t0 = Date.now()
const r = await runSearchChain({ query: q, count: 8 })
console.log(`engine: ${r.engine} | results: ${r.results.length} | ${((Date.now()-t0)/1000).toFixed(2)}s`)
for (const x of r.results.slice(0, 3)) console.log('  -', (x.title || '').slice(0, 56), '|', (x.url || '').slice(0, 48))
