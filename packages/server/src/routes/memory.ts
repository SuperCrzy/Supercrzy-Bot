import Router from 'koa-router'
import type { Context } from 'koa'
import { getDB } from '../services/database'
import { upsertMemory } from '../services/memory-service'
import { normalizeCategory, normalizeImportance } from '../services/memory-category'
import { config } from '../config'

export const memoryRouter = new Router({ prefix: '/api/memory' })

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

// List all memories
memoryRouter.get('/', (ctx: Context) => {
  const db = getDB()
  const { category, search } = ctx.query

  let sql = 'SELECT * FROM agent_memory'
  const params: string[] = []
  const conditions: string[] = []

  if (category && category !== 'all') {
    conditions.push('category = ?')
    params.push(category as string)
  }
  if (search) {
    conditions.push('(key LIKE ? OR content LIKE ?)')
    params.push(`%${search}%`, `%${search}%`)
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ')
  }
  sql += ' ORDER BY updated_at DESC'

  const rows = db.prepare(sql).all(...params)
  ctx.body = rows
})

// Get single memory
memoryRouter.get('/:id', (ctx: Context) => {
  const db = getDB()
  const row = db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(ctx.params.id)
  if (!row) {
    ctx.status = 404
    ctx.body = { error: 'Memory not found' }
    return
  }
  ctx.body = row
})

// Create memory
memoryRouter.post('/', (ctx: Context) => {
  const db = getDB()
  const body = ctx.request.body as { key: string; content: string; category?: string; importance?: number }

  if (!body.key || !body.content) {
    ctx.status = 400
    ctx.body = { error: 'key and content are required' }
    return
  }

  // 2026-09-18：改走统一写入入口。
  // 原先此处是裸 INSERT：同 key 会插出重复行（与"同 key 覆盖"的其它路径行为不一致），
  // 且 category 完全不校验（能落进任何脏值，包括已废弃的 'fact'）。
  // importance 原先默认 1 —— 用户手动存的记忆反而排在全表最低，候选池按 importance 取时永远进不去；
  // 这里改默认 5（= normal），用户显式传入的值仍然尊重。
  const result = upsertMemory(db, {
    key: body.key,
    content: body.content,
    category: body.category,
    importance: body.importance ?? 5,
  })
  if (result.action === 'rejected') {
    ctx.status = 400
    ctx.body = { error: result.reason || 'invalid memory' }
    return
  }

  const row = db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(result.id)
  ctx.status = 201
  ctx.body = row
})

// Update memory
memoryRouter.put('/:id', (ctx: Context) => {
  const db = getDB()
  const body = ctx.request.body as { key?: string; content?: string; category?: string; importance?: number }

  const existing = db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(ctx.params.id)
  if (!existing) {
    ctx.status = 404
    ctx.body = { error: 'Memory not found' }
    return
  }

  const updates: string[] = []
  const params: any[] = []

  if (body.key !== undefined) { updates.push('key = ?'); params.push(body.key) }
  if (body.content !== undefined) { updates.push('content = ?'); params.push(body.content) }
  // 分类与 importance 一律归一（原先原样入库，脏分类会直接落库并被注入 system prompt）
  if (body.category !== undefined) { updates.push('category = ?'); params.push(normalizeCategory(body.category)) }
  if (body.importance !== undefined) { updates.push('importance = ?'); params.push(normalizeImportance(body.importance)) }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')")
    params.push(ctx.params.id)
    db.prepare(`UPDATE agent_memory SET ${updates.join(', ')} WHERE id = ?`).run(...params)
  }

  const row = db.prepare('SELECT * FROM agent_memory WHERE id = ?').get(ctx.params.id)
  ctx.body = row
})

// Delete memory
memoryRouter.delete('/:id', (ctx: Context) => {
  const db = getDB()
  const result = db.prepare('DELETE FROM agent_memory WHERE id = ?').run(ctx.params.id)
  if (result.changes === 0) {
    ctx.status = 404
    ctx.body = { error: 'Memory not found' }
    return
  }
  ctx.body = { success: true }
})

// Search memories by keyword
memoryRouter.post('/search', (ctx: Context) => {
  const db = getDB()
  const body = ctx.request.body as { query: string; limit?: number }

  if (!body.query) {
    ctx.status = 400
    ctx.body = { error: 'query is required' }
    return
  }

  const limit = body.limit || 10
  const rows = db.prepare(
    `SELECT * FROM agent_memory
     WHERE key LIKE ? OR content LIKE ?
     ORDER BY importance DESC, updated_at DESC
     LIMIT ?`
  ).all(`%${body.query}%`, `%${body.query}%`, limit)

  ctx.body = rows
})

// Import memory candidates from an AI conversation markdown (AI 梳理，用户确认后批量保存)
memoryRouter.post('/import', async (ctx: Context) => {
  const body = ctx.request.body as { text?: string }
  const text = (body.text || '').trim()
  if (!text) {
    ctx.status = 400
    ctx.body = { error: 'text is required' }
    return
  }

  const db = getDB()
  const apiKey = (db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any)?.value || config.deepseek.apiKey
  if (!apiKey) {
    ctx.status = 400
    ctx.body = { error: 'API Key not configured. Please set it in Settings.' }
    return
  }
  const baseUrl = config.deepseek.baseUrl

  const systemPrompt = `你是记忆梳理助手。从用户提供的 AI 对话记录中提取值得长期记忆的信息（用户偏好、项目事实、经验教训、决策结论、重要约定）。
规则：
1. 只提取跨对话仍有价值的信息；过滤寒暄、一次性内容、重复内容。
2. key 是短标签（如"工作流偏好"），content 是具体内容（可含要点）。
3. category 取值：user(用户身份/个人事实) / preference(用户偏好) / rule(经验教训或约定) / knowledge(项目事实) / topic(长期关注方向) / general(通用)。
   注意：不要再使用已废弃的 fact —— 项目事实一律归 knowledge。
4. importance 为 1-5 整数，5 最重要。
5. 最多返回 10 条。
6. 只输出 JSON 数组，不要 markdown 代码块、不要多余解释。
格式：[{"key":"...","content":"...","category":"preference","importance":3}]`

  try {
    const resp = await fetch(`${normalizeBaseUrl(baseUrl)}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey.startsWith('tp-') ? { 'api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model: config.deepseek.defaultModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text.slice(0, 30000) },
        ],
        temperature: 0.3,
        max_tokens: 2500,
      }),
    })

    if (!resp.ok) {
      ctx.status = 502
      ctx.body = { error: `AI 梳理失败（HTTP ${resp.status}）` }
      return
    }
    const data = await resp.json()
    const raw = data?.choices?.[0]?.message?.content || ''
    const candidates = parseMemoryCandidates(raw)
    ctx.body = { candidates }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: `AI 梳理失败: ${err.message}` }
  }
})

/** 解析 LLM 返回的记忆候选 JSON（容错：剥 markdown 围栏、兼容对象包裹） */
function parseMemoryCandidates(raw: string): Array<{ key: string; content: string; category: string; importance: number }> {
  try {
    let s = raw.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()
    // 兼容 {"candidates":[...]} / {"memories":[...]} 包裹
    if (!s.startsWith('[')) {
      const obj = JSON.parse(s)
      s = JSON.stringify(obj.candidates || obj.memories || obj.items || [])
    }
    const arr = JSON.parse(s)
    if (!Array.isArray(arr)) return []
    // 2026-09-18：词表来自 memory-category.ts（原先是本文件私有的 ['general','preference','fact','rule']，
    // 含已废弃的 'fact'，且缺 preference/rule 之外的合法分类）
    return arr
      .map((x: any) => ({
        key: String(x.key || x.title || '').trim().slice(0, 100),
        content: String(x.content || x.description || x.text || '').trim().slice(0, 2000),
        category: normalizeCategory(x.category),
        importance: Math.min(5, Math.max(1, parseInt(String(x.importance ?? x.star ?? 3), 10) || 1)),
      }))
      .filter((x: any) => x.key && x.content)
  } catch {
    return []
  }
}
