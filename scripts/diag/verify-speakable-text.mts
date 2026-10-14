/**
 * 统计：有多少条真实 AI 回复「点了朗读完全没反应」。
 *
 * 死路（代码事实）：`useChatSpeech.toggleSpeak` → `const text = extractSpeakText(msg.content)`
 * → `if (!text) return`（**静默**）。而朗读按钮的渲染条件是
 * `v-if="speechSupported && !chatStore.isLoading && msg.content"` ——
 * 只判 `msg.content` 非空，**不判清洗后是否还有可读文本**。
 * ⇒ 纯代码块 / 纯表格 / 纯 emoji / 纯链接的回复，按钮照常出现，点了毫无反应。
 *
 * 本脚本用**真实的 extractSpeakText**（不经任何复制粘贴）跑真实库里的 messages，
 * 目的不是"证明函数对不对"，而是量化**这条死路在真实数据上有多常见**。
 */
import Database from 'better-sqlite3'
import { extractSpeakText } from '../../packages/client/src/utils/speech-text.ts'

const DB = '/Users/chaojiphonekuang/.supercrzy/data/supercrzy.db'
const db = new Database(DB, { readonly: true, fileMustExist: true })

const rows = db
  .prepare("SELECT id, session_id, content FROM messages WHERE role = 'assistant' ORDER BY created_at DESC")
  .all() as Array<{ id: string; session_id: string; content: string }>

let nonEmpty = 0
const dead: Array<{ id: string; len: number; head: string }> = []
for (const r of rows) {
  const c = String(r.content || '')
  if (!c.trim()) continue
  nonEmpty += 1
  const t = extractSpeakText(c)
  if (!t) dead.push({ id: r.id, len: c.length, head: c.replace(/\s+/g, ' ').trim().slice(0, 70) })
}

console.log(`库里 assistant 消息：${rows.length} 条（其中 content 非空 ${nonEmpty} 条）`)
console.log(`按钮会出现但点了没反应的（清洗后为空）：${dead.length} 条  = ${((dead.length / Math.max(nonEmpty, 1)) * 100).toFixed(1)}%`)
console.log('--- 前 10 条样本 ---')
for (const d of dead.slice(0, 10)) console.log(`  [${d.len}字] ${d.head}`)

// 顺带量一下"清洗把正文削掉多少"—— 影响的是"读出来是否完整"，与上面的死路无关
const ratios = rows
  .filter((r) => String(r.content || '').trim())
  .map((r) => {
    const c = String(r.content)
    return { raw: c.length, speak: extractSpeakText(c).length }
  })
  .filter((x) => x.raw > 200)
const avgKeep = ratios.reduce((a, b) => a + b.speak / b.raw, 0) / Math.max(ratios.length, 1)
console.log(`\n长回复（原始 >200 字，共 ${ratios.length} 条）清洗后平均保留 ${(avgKeep * 100).toFixed(1)}% 字符`)

db.close()
