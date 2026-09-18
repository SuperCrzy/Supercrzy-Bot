/**
 * 共享 LLM 配置（2026-09-01 从 ghost-engine 抽出，供 collab/质检/议院/新串行引擎复用）
 * 单一配置入口：读取 settings 表 model/apiKey + custom_providers 兜底 + config 兜底。
 */
import { getDB } from './database'
import { config } from '../config'

export function normalizeBaseUrl(url: string): string {
  // 去掉尾部斜杠和重复的 /v1（DB 中 base_url 可能已含 /v1）
  return (url || '').replace(/\/+$/, '').replace(/\/v1$/, '')
}

export function getLLMConfig() {
  const db = getDB()
  const modelRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('model') as any
  const keyRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('apiKey') as any
  let apiKey = keyRow?.value || ''
  let baseUrl = config.deepseek.baseUrl
  if (!apiKey) {
    const cp = db.prepare("SELECT base_url, api_key FROM custom_providers WHERE provider_key='deepseek'").get() as any
    apiKey = cp?.api_key || ''
    if (cp?.base_url) baseUrl = cp.base_url
  }
  if (!apiKey) apiKey = config.deepseek.apiKey
  return {
    model: modelRow?.value || config.deepseek.defaultModel,
    apiKey,
    baseUrl,
  }
}

/** 品牌偏好模型（按可用性人工校正，优先于 prefix 猜测；别选函数模型/失效旧模型） */
const PROVIDER_PREFERRED_MODEL: Record<string, string> = {
  kimi: 'kimi-k2.6',   // moonshot-v1-*/kimi-k2.5 失效；k2.6 实测可用
}

/** 读取指定 provider 的配置（多品牌议院用：deepseek/kimi/…） */
export function getProviderConfig(providerKey: string) {
  const db = getDB()
  // custom_providers 的 model 在 models(JSON数组)，无独立 model 列；主模型兜底
  const p = db.prepare("SELECT base_url, api_key, models FROM custom_providers WHERE provider_key = ? AND enabled = 1").get(providerKey) as any
  if (!p || !p.api_key) return null
  let model = ''
  try {
    const list = JSON.parse(p.models || '[]')
    const models = list.map((m: any) => m?.model_id || m?.id || m).filter(Boolean) as string[]
    // 优先：品牌偏好模型，其次 is_default，再回退 models[0]
    const pref = PROVIDER_PREFERRED_MODEL[providerKey]
    model = (pref && models.includes(pref))
      ? pref
      : models.find((m) => list.find((x: any) => (x?.model_id || x?.id) === m)?.is_default)
        || models[0]
        || ''
  } catch { /* ignore */ }
  if (!model) {
    const main = getLLMConfig()
    model = main.model
  }
  return {
    baseUrl: normalizeBaseUrl(p.base_url || config.deepseek.baseUrl),
    apiKey: p.api_key,
    model,
  }
}

/** 直接调用指定 provider 的 chat completion（无需 main 模型的 agent 循环） */
export async function chatWithProvider(
  providerKey: string,
  messages: Array<{ role: string; content: string }>,
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  const p = getProviderConfig(providerKey)
  if (!p) throw new Error(`provider ${providerKey} 未配置可用 key`)
  const body: Record<string, unknown> = {
    model: p.model,
    messages,
    max_tokens: opts.maxTokens ?? 2000,
  }
  // 兼容各品牌 temperature 限制（如 Kimi k2.x 只允许 temperature=1，传 0.3 会 400）
  // 仅显式指定时传；Kimi 一律用其默认（省略）或显式 1
  if (opts.temperature !== undefined) {
    if (providerKey === 'kimi') body.temperature = 1
    else body.temperature = opts.temperature
  }
  const controller = new AbortController()
  const timer = opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : null
  try {
    const resp = await fetch(`${p.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`)
    const data = (await resp.json()) as any
    return String(data?.choices?.[0]?.message?.content || '').trim()
  } finally {
    if (timer) clearTimeout(timer)
  }
}
