/** Real run: confirms deep_research produces sourced output, not a memory dump. */
import { initDatabase } from '../../src/services/database.js'
import { runDeepResearch } from '../../src/services/deep-research.js'

initDatabase()
const q = process.argv[2] || 'Anthropic IPO 估值'
const t0 = Date.now()
const r = await runDeepResearch({
  query: q, breadth: 2, depth: 1,
  onProgress: (p: any) => console.log(`  · depth ${p.currentDepth}/${p.totalDepth} q ${p.completedQueries}/${p.totalQueries || '?'}`),
})
console.log(`\nelapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`)
console.log('learnings:', r.learnings.length, '| visitedUrls:', r.visitedUrls.length, '| report chars:', r.report.length)
console.log('urls:', r.visitedUrls.slice(0, 4))
console.log('\n--- report head ---\n' + r.report.slice(0, 320))
