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

/** 读取指定 provider 的配置（多品牌议院用：deepseek/kimi/…） */
export function getProviderConfig(providerKey: string) {
  const db = getDB()
  const p = db.prepare("SELECT base_url, api_key, model FROM custom_providers WHERE provider_key = ? AND enabled = 1").get(providerKey) as any
  if (!p || !p.api_key) return null
  return {
    baseUrl: normalizeBaseUrl(p.base_url || config.deepseek.baseUrl),
    apiKey: p.api_key,
    model: p.model || config.deepseek.defaultModel,
  }
}

/** 直接调用指定 provider 的 chat completion（无需 main 模型的 agent 循环） */
export async function chatWithProvider(
  providerKey: string,
  messages: Array<{ role: string; content: string }>,
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const p = getProviderConfig(providerKey)
  if (!p) throw new Error(`provider ${providerKey} 未配置可用 key`)
  const resp = await fetch(`${p.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
    body: JSON.stringify({
      model: p.model,
      messages,
      max_tokens: opts.maxTokens ?? 2000,
      temperature: opts.temperature ?? 0.3,
    }),
  })
  if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}`)
  const data = (await resp.json()) as any
  return String(data?.choices?.[0]?.message?.content || '').trim()
}
