/**
 * 模型计价的唯一来源（2026-10-22）
 *
 * 为什么要有这个文件：以前价格表写在 `agent.ts` 的 MODEL_PRICES，单位写「¥/1M」且没有缓存命中价；
 * 客户端 `data/models.ts` 里又有一份完全不同的 USD 报价（pro 0.435/0.87），两份互不相干。
 * 现在只留这里一份，单位统一为 **USD / 1M tokens**，因为官方定价页就是美元——
 * 换算成人民币只发生在最后一步（`estimateCostCny`），有且只有一个汇率常量。
 *
 * 官方数字（https://api-docs.deepseek.com/quick_start/pricing，2026-10-22 核对）：
 *
 *   model              cache hit        cache miss        output
 *                      off-peak / peak  off-peak / peak   off-peak / peak
 *   deepseek-flash     $0.003 / 0.006    $0.15 / 0.3       $0.6 / 1.2
 *   deepseek-v4-pro    $0.022 / 0.044    $0.66 / 1.32      $1.98 / 3.96
 *
 * 高峰时段 = UTC 周一至周五 01:00–04:00 与 06:00–10:00；其余（含周末）为平峰，价 = 高峰一半。
 * 官方还排除「中国法定节假日」，这里没做节假日日历 —— 节假日会按高峰价估算（偏高），
 * 属于**高估而非低估**，宁可保守。
 *
 * 两份旧表的差额是量级级别：旧 pro ¥2/1M 输入 ≈ $0.28，实际峰值 $1.32，低估约 4.7 倍。
 */

/** 唯一汇率常量：官方定价是美元，DB 里 messages.cost 存的是人民币，换算只发生在这里 */
export const USD_TO_CNY = 7.2

/** 峰谷价 */
export interface PriceTier {
  /** 高峰价（USD / 1M tokens） */
  peak: number
  /** 平峰价（USD / 1M tokens），官方 = 高峰的一半 */
  offPeak: number
}

export interface ModelPrice {
  /** 缓存命中的输入价；缺省 = 该模型不区分缓存，全部按 cacheMiss 算 */
  cacheHit?: PriceTier
  cacheMiss: PriceTier
  output: PriceTier
  /** official = 已核对官方定价页；legacy = 沿用历史近似值，未核对 */
  source: 'official' | 'legacy'
}

const flat = (v: number): PriceTier => ({ peak: v, offPeak: v })
const halved = (peak: number): PriceTier => ({ peak, offPeak: peak / 2 })

/**
 * 计价表。键是**计费主体**，不是用户界面里选的型号：
 * `deepseek-v4-flash` 是已退役的旧名，官方仍接受，实际由 V4.1-Flash 承接并按 Flash 价计费。
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  'deepseek-flash': {
    cacheHit: halved(0.006),
    cacheMiss: halved(0.3),
    output: halved(1.2),
    source: 'official',
  },
  'deepseek-v4-pro': {
    cacheHit: halved(0.044),
    cacheMiss: halved(1.32),
    output: halved(3.96),
    source: 'official',
  },
  // 以下沿用旧表（¥/1M ÷ 7.2 得到），没有核对过官方定价页 —— 只作数量级参考。
  // 标 legacy 是为了让 UI / 审计能区分「这条费用是按官方价算的」还是「按历史近似值算的」。
  'kimi-k2.6': { cacheMiss: flat(4 / USD_TO_CNY), output: flat(16 / USD_TO_CNY), source: 'legacy' },
  'moonshot-v1-8k': { cacheMiss: flat(4 / USD_TO_CNY), output: flat(16 / USD_TO_CNY), source: 'legacy' },
  'gpt-4o': { cacheMiss: flat(18 / USD_TO_CNY), output: flat(72 / USD_TO_CNY), source: 'legacy' },
  'gpt-4.1': { cacheMiss: flat(15 / USD_TO_CNY), output: flat(60 / USD_TO_CNY), source: 'legacy' },
  'claude-sonnet-4-20250514': { cacheMiss: flat(21 / USD_TO_CNY), output: flat(105 / USD_TO_CNY), source: 'legacy' },
  'glm-4.7': { cacheMiss: flat(2 / USD_TO_CNY), output: flat(6 / USD_TO_CNY), source: 'legacy' },
  'mimo-v2.5-pro': { cacheMiss: flat(2 / USD_TO_CNY), output: flat(8 / USD_TO_CNY), source: 'legacy' },
  'deepseek-chat': { cacheMiss: flat(0.5 / USD_TO_CNY), output: flat(2 / USD_TO_CNY), source: 'legacy' },
}

/** 未收录模型：沿用旧默认 ¥2/¥8 折算，宁可偏高 */
export const DEFAULT_PRICING: ModelPrice = {
  cacheMiss: flat(2 / USD_TO_CNY),
  output: flat(8 / USD_TO_CNY),
  source: 'legacy',
}

/**
 * 型号名 → 计费主体。
 * 已退役的旧名按官方口径折到现行模型上，否则 `deepseek-v4-flash` 会掉进默认价，
 * 而它其实是 Flash 价（见定价页脚注 1）。
 */
export function normalizePricingModel(model?: string): string {
  const m = String(model || '').trim().toLowerCase()
  if (!m) return ''
  if (m === 'deepseek-v4-flash' || m === 'deepseek-v4-flash-vision-exp') return 'deepseek-flash'
  if (m.startsWith('deepseek-v4-pro')) return 'deepseek-v4-pro'
  return m
}

export function getPricing(model?: string): ModelPrice {
  const key = normalizePricingModel(model)
  return MODEL_PRICING[key] || DEFAULT_PRICING
}

/** 高峰时段：UTC 周一至周五 01:00–04:00、06:00–10:00（官方未计中国法定节假日） */
export function isPeakHour(at: Date = new Date()): boolean {
  const day = at.getUTCDay() // 0=周日 … 6=周六
  if (day === 0 || day === 6) return false
  const h = at.getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

/** 模型返回的 usage（各家字段略有差异，都接受） */
export interface UsageLike {
  prompt_tokens?: number
  completion_tokens?: number
  /** DeepSeek：命中缓存的输入 token */
  prompt_cache_hit_tokens?: number
  /** DeepSeek：未命中缓存的输入 token */
  prompt_cache_miss_tokens?: number
  /** OpenAI 风格 */
  prompt_tokens_details?: { cached_tokens?: number }
}

/**
 * 估算本轮费用（USD）。
 *
 * 缓存命中/未命中必须分开算：官方两者差 50 倍，混在一起按 miss 计价会把便宜的部分
 * 记成贵的（实测重复系统提示命中率很高，误差不小）。缺字段时按「全部未命中」算，
 * 也就是宁高不低。
 */
export function estimateCostUsd(model: string | undefined, usage: UsageLike, at: Date = new Date()): number {
  const price = getPricing(model)
  const tier = isPeakHour(at) ? 'peak' : 'offPeak'
  const promptTokens = usage.prompt_tokens || 0
  const completionTokens = usage.completion_tokens || 0

  let hit = usage.prompt_cache_hit_tokens || usage.prompt_tokens_details?.cached_tokens || 0
  if (hit > promptTokens) hit = promptTokens // 脏数据防御：命中数不可能超过输入数
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(promptTokens - hit, 0)

  const hitPrice = price.cacheHit ? price.cacheHit[tier] : price.cacheMiss[tier]
  const usd =
    (hit * hitPrice + miss * price.cacheMiss[tier] + completionTokens * price.output[tier]) / 1e6

  return usd
}

/** 估算本轮费用（¥，DB 存储口径；保留 4 位小数避免小额费用被抹成 0） */
export function estimateCostCny(model: string | undefined, usage: UsageLike, at: Date = new Date()): number {
  return Math.round(estimateCostUsd(model, usage, at) * USD_TO_CNY * 10000) / 10000
}
