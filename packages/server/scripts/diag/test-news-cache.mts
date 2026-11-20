/** Verifies news_search falls back to the persisted feed cache when the source is down. */
import { initDatabase, getDB } from '../../src/services/database.js'
import { directoryTools } from '../../src/tools/registry.js'

initDatabase()
const db = getDB()
const items = [{
  title: 'CACHED-ITEM 缓存回退验证',
  url: 'https://supercrzy.com/test-cached',
  summary: '这是本地缓存的条目，用于验证源站不可达时的回退。',
  date: new Date().toISOString(),
  category: 'Models',
}]
db.prepare("INSERT INTO settings(key,value) VALUES('newsFeedCache',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
  .run(JSON.stringify({ at: Date.now(), items }))

const tool = directoryTools.find(t => t.name === 'news_search')!
const t0 = Date.now()
const out = await tool.execute({ query: '' }, { cwd: process.cwd(), workspaceDir: process.cwd() } as any)
console.log(`elapsed ${((Date.now()-t0)/1000).toFixed(1)}s`)
console.log(String(out).slice(0, 420))
