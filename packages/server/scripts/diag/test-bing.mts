import { initDatabase } from '../../src/services/database.js'
import { SEARCH_PROVIDERS } from '../../src/services/search-providers.js'
initDatabase()
const bing = SEARCH_PROVIDERS.find(p => p.name === 'bing')!
const t0 = Date.now()
const rows = await bing.search({ query: 'Anthropic IPO valuation', count: 5 } as any)
console.log(`bing: ${rows.length} rows in ${((Date.now()-t0)/1000).toFixed(2)}s`)
for (const r of rows.slice(0, 3)) console.log('  -', (r.title || '').slice(0, 52))
