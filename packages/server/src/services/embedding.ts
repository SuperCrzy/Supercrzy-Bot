// Embedding 提供方抽象（2026-08-23，对齐 WorkBuddy"embedding 余弦 + BM25 融合"）
// 配置（settings 表，可选——不配则整个混合检索退化回纯 FTS5）：
//   embeddingApiKey  必配才激活（也读 env EMBEDDING_API_KEY）
//   embeddingBaseUrl 默认 https://api.siliconflow.cn/v1（硅基流动，BGE-M3 免费额度；OpenAI 兼容格式）
//   embeddingModel   默认 BAAI/bge-m3
// OpenAI 兼容端点：POST {baseUrl}/embeddings { model, input: string | string[] } → data[].embedding

import { getDB } from './database'

function readSetting(key: string): string {
  try {
    const row = getDB().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
    return row?.value ? String(row.value).trim() : ''
  } catch {
    return ''
  }
}

/** 简单内存缓存（记忆量小，全量缓存即可） */
const cache = new Map<string, number[]>()

export function embeddingEnabled(): boolean {
  return !!(readSetting('embeddingApiKey') || process.env.EMBEDDING_API_KEY)
}

function getConfig() {
  const baseUrl = (readSetting('embeddingBaseUrl') || process.env.EMBEDDING_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '')
  const model = readSetting('embeddingModel') || process.env.EMBEDDING_MODEL || 'BAAI/bge-m3'
  const apiKey = readSetting('embeddingApiKey') || process.env.EMBEDDING_API_KEY || ''
  return { baseUrl, model, apiKey }
}

/** 批量获取 embedding（OpenAI 兼容；单条内部也走批量，减少请求数） */
export async function getEmbeddings(texts: string[]): Promise<Array<number[] | null>> {
  const { baseUrl, model, apiKey } = getConfig()
  if (!apiKey) return texts.map(() => null)

  const results: Array<number[] | null> = new Array(texts.length)
  const uncached: Array<{ idx: number; text: string }> = []
  texts.forEach((t, idx) => {
    const key = t.slice(0, 300)
    if (cache.has(key)) results[idx] = cache.get(key)!
    else uncached.push({ idx, text: key })
  })
  if (uncached.length === 0) return results

  try {
    const resp = await fetch(`${baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: uncached.map((u) => u.text) }),
      signal: AbortSignal.timeout(60000),
    })
    if (!resp.ok) return texts.map(() => null)
    const data = await resp.json() as any
    const arr = Array.isArray(data?.data) ? data.data : []
    for (let i = 0; i < arr.length && i < uncached.length; i++) {
      const emb = arr[i]?.embedding
      if (Array.isArray(emb)) {
        cache.set(uncached[i].text, emb)
        results[uncached[i].idx] = emb
      }
    }
  } catch { /* embedding 失败 → 该项为 null，调用方退化为纯 ranking */ }

  return results
}

/** 单条 embedding（便捷封装） */
export async function getEmbedding(text: string): Promise<number[] | null> {
  const [r] = await getEmbeddings([text])
  return r
}

/** 余弦相似度（-1 ~ 1） */
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 归一化到 0-1（cosine -1~1 → 0~1） */
export function normCosine(a: number[], b: number[]): number {
  return (cosine(a, b) + 1) / 2
}
