/**
 * Verify tool recall against the **real** catalogue (not fixtures).
 *
 * Why a script and not only unit tests: the unit tests use fixture descriptions, so they cannot
 * catch "the real description text no longer contains the word users would search for". This runs
 * the actual `tool_search` executor over the assembled tool registry.
 *
 * Usage:
 *   ./node_modules/.bin/tsx --tsconfig packages/server/tsconfig.json scripts/diag/check-tool-recall.mts [query…]
 */
import toolSearch from '../../packages/server/src/tools/tool-search'

// Importing the registry assembles `toolDefinitions` and calls setToolCatalog()
await import('../../packages/server/src/services/tools')

const queries = process.argv.slice(2)
const list = queries.length ? queries : ['后台任务', '生成图片', '架构图', '视频', 'terminal', 'git', 'zzz-nonexistent']

for (const q of list) {
  const out = String(await toolSearch.execute({ query: q }, {} as any))
  const lines = out.split('\n')
  const hits = lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).split(':')[0])
  const verdict = hits.length ? `hit ${hits.length}: ${hits.join(', ')}` : 'NO MATCH'
  console.log(`[${q}] → ${verdict}`)
}
