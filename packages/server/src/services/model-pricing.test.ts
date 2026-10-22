/**
 * 模型计价（2026-10-22）
 *
 * 缺陷背景：同一件事有三份口径 ——
 * ① server `agent.ts` 的 MODEL_PRICES 写「¥/1M」：pro ¥2 输入 / ¥8 输出，且不分缓存与峰谷；
 * ② client `data/models.ts` 另有一份 USD：pro 0.435 / 0.87；
 * ③ 界面 `formatCurrency` 按语言把同一个人民币数字换成 $ 显示（数值不变、符号变 ⇒ 缩小 7.2 倍）。
 *
 * 官方定价页（2026-10-22 核对）真实数字：pro 缓存未命中输入峰值 $1.32/1M、输出 $3.96/1M，
 * 平峰减半；缓存命中输入峰值仅 $0.044 —— 与旧表差一个量级。
 *
 * 这里钉住的是「口径本身」：
 * 1. 官方价必须与定价页一致（数字写错 = 所有费用全错，且没人看得出来）
 * 2. 缓存命中必须真的便宜（分档生效，不是摆设）
 * 3. 峰谷必须真的差一倍
 * 4. 已退役旧名 deepseek-v4-flash 必须按 Flash 价计费，不能掉进默认价
 * 5. 计价表全仓只有一份（护栏：其他文件不许再出现价格数字）
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import {
  MODEL_PRICING,
  DEFAULT_PRICING,
  USD_TO_CNY,
  getPricing,
  isPeakHour,
  normalizePricingModel,
  estimateCostUsd,
  estimateCostCny,
} from './model-pricing'

/** 2026-10-22 是周四；UTC 02:30 落在高峰窗口 01:00–04:00 */
const PEAK = new Date('2026-10-22T02:30:00Z')
/** 同一 UTC 日的 12:30 是平峰 */
const OFF_PEAK = new Date('2026-10-22T12:30:00Z')
/** 周六 02:30 也算平峰 */
const WEEKEND = new Date('2026-10-24T02:30:00Z')

describe('官方定价（核对值，写错即全错）', () => {
  it('deepseek-v4-pro：命中 0.044 / 未命中 1.32 / 输出 3.96（USD 峰值）', () => {
    const p = MODEL_PRICING['deepseek-v4-pro']
    expect(p.source).toBe('official')
    expect(p.cacheHit?.peak).toBe(0.044)
    expect(p.cacheMiss.peak).toBe(1.32)
    expect(p.output.peak).toBe(3.96)
  })

  it('deepseek-flash：命中 0.006 / 未命中 0.3 / 输出 1.2（USD 峰值）', () => {
    const p = MODEL_PRICING['deepseek-flash']
    expect(p.source).toBe('official')
    expect(p.cacheHit?.peak).toBe(0.006)
    expect(p.cacheMiss.peak).toBe(0.3)
    expect(p.output.peak).toBe(1.2)
  })

  it('平峰价恰为峰值一半（官方口径）', () => {
    for (const key of ['deepseek-flash', 'deepseek-v4-pro']) {
      const p = MODEL_PRICING[key]
      expect(p.cacheHit!.offPeak).toBeCloseTo(p.cacheHit!.peak / 2, 10)
      expect(p.cacheMiss.offPeak).toBeCloseTo(p.cacheMiss.peak / 2, 10)
      expect(p.output.offPeak).toBeCloseTo(p.output.peak / 2, 10)
    }
  })

  it('🔴 旧表低估：pro 峰值输入价是旧表 ¥2/1M 的 4 倍以上', () => {
    // 旧表 pro 输入 ¥2/1M ≈ $0.28；官方峰值 $1.32
    const oldUsd = 2 / USD_TO_CNY
    expect(MODEL_PRICING['deepseek-v4-pro'].cacheMiss.peak / oldUsd).toBeGreaterThan(4)
  })
})

describe('峰谷判定', () => {
  it('UTC 01:00–04:00 与 06:00–10:00 为高峰', () => {
    for (const h of [1, 3, 6, 9]) {
      expect(isPeakHour(new Date(Date.UTC(2026, 9, 22, h, 0)))).toBe(true)
    }
  })

  it('窗口边界：04:00 与 10:00 已经是平峰（左闭右开）', () => {
    expect(isPeakHour(new Date(Date.UTC(2026, 9, 22, 4, 0)))).toBe(false)
    expect(isPeakHour(new Date(Date.UTC(2026, 9, 22, 10, 0)))).toBe(false)
    expect(isPeakHour(new Date(Date.UTC(2026, 9, 22, 0, 59)))).toBe(false)
  })

  it('周末全天平峰', () => {
    expect(WEEKEND.getUTCDay()).toBe(6)
    expect(isPeakHour(WEEKEND)).toBe(false)
  })
})

describe('型号归一', () => {
  it('已退役旧名 deepseek-v4-flash → deepseek-flash（官方按 Flash 价计费）', () => {
    expect(normalizePricingModel('deepseek-v4-flash')).toBe('deepseek-flash')
    expect(getPricing('deepseek-v4-flash')).toBe(MODEL_PRICING['deepseek-flash'])
  })

  it('🔴 旧名不会掉进默认价（默认价比 Flash 贵，会让费用虚高）', () => {
    const pricing = getPricing('deepseek-v4-flash')
    expect(pricing).not.toBe(DEFAULT_PRICING)
    expect(pricing.cacheMiss.peak).toBe(0.3)
  })

  it('大小写/空白不影响归一', () => {
    expect(normalizePricingModel('  DeepSeek-V4-Pro ')).toBe('deepseek-v4-pro')
  })

  it('未知模型回退默认价，并标 legacy（不冒充官方价）', () => {
    const p = getPricing('some-unknown-model')
    expect(p).toBe(DEFAULT_PRICING)
    expect(p.source).toBe('legacy')
  })
})

describe('费用计算', () => {
  it('缓存命中真的便宜：99% 命中比 0% 命中便宜一个量级', () => {
    const allMiss = estimateCostUsd('deepseek-v4-pro', { prompt_tokens: 100_000, completion_tokens: 0 }, PEAK)
    const mostlyHit = estimateCostUsd('deepseek-v4-pro', {
      prompt_tokens: 100_000,
      completion_tokens: 0,
      prompt_cache_hit_tokens: 99_000,
      prompt_cache_miss_tokens: 1_000,
    }, PEAK)
    expect(mostlyHit).toBeLessThan(allMiss / 5)
    expect(allMiss).toBeCloseTo(0.132, 6) // 100K × $1.32/1M
  })

  it('缺缓存字段时按全部未命中算（宁高不低，不假装省了钱）', () => {
    const noFields = estimateCostUsd('deepseek-v4-pro', { prompt_tokens: 1_000_000 }, PEAK)
    const explicitMiss = estimateCostUsd('deepseek-v4-pro', {
      prompt_tokens: 1_000_000, prompt_cache_miss_tokens: 1_000_000,
    }, PEAK)
    expect(noFields).toBeCloseTo(explicitMiss, 10)
    expect(noFields).toBeCloseTo(1.32, 6)
  })

  it('兼容 OpenAI 风格 prompt_tokens_details.cached_tokens', () => {
    const openaiStyle = estimateCostUsd('deepseek-v4-pro', {
      prompt_tokens: 1_000_000,
      prompt_tokens_details: { cached_tokens: 1_000_000 },
    }, PEAK)
    expect(openaiStyle).toBeCloseTo(0.044, 6)
  })

  it('脏数据防御：命中数超过输入数时按输入数封顶（不会算出负费用）', () => {
    const cost = estimateCostUsd('deepseek-v4-pro', {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 999_999,
      prompt_cache_miss_tokens: 0,
    }, PEAK)
    expect(cost).toBeGreaterThan(0)
    expect(cost).toBeCloseTo((1000 * 0.044) / 1e6, 12)
  })

  it('平峰价恰为峰值一半（端到端，不只查表）', () => {
    const at = (d: Date) => estimateCostUsd('deepseek-v4-pro', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, d)
    expect(at(OFF_PEAK)).toBeCloseTo(at(PEAK) / 2, 10)
  })

  it('人民币口径 = USD × 固定汇率', () => {
    const cny = estimateCostCny('deepseek-v4-pro', { prompt_tokens: 1_000_000 }, PEAK)
    expect(cny).toBeCloseTo(1.32 * USD_TO_CNY, 3)
  })

  it('小额费用不被四舍五入抹成 0（单轮几百 token 也要能看见）', () => {
    const cny = estimateCostCny('deepseek-v4-pro', { prompt_tokens: 500, completion_tokens: 200 }, PEAK)
    expect(cny).toBeGreaterThan(0)
  })
})

describe('护栏：价格表全仓只有一份', () => {
  const here = dirname(fileURLToPath(import.meta.url))

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p, out)
      else if (/\.(ts|vue)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p)
    }
    return out
  }

  it('server/services 里除 model-pricing.ts 外，没有第二份按 1M 计价的价格表', () => {
    const roots = [join(here, '..', 'routes'), here, join(here, '..', 'tools')]
    const offenders: string[] = []
    for (const root of roots) {
      let files: string[] = []
      try { files = walk(root) } catch { continue }
      for (const f of files) {
        if (f.endsWith('model-pricing.ts')) continue
        const text = readFileSync(f, 'utf8')
        // 典型价格表特征：模型名 + prompt/completion 单价，或 cacheHit/cacheMiss 单价
        if (/(deepseek-v4-pro|deepseek-flash|gpt-4o)\s*:\s*\{[^}]*\b(0\.[0-9]|[0-9]+\.[0-9]+)\b/.test(text)) {
          offenders.push(f)
        }
      }
    }
    expect(offenders, `这些文件里还有第二份价格表：${offenders.join(', ')}`).toEqual([])
  })

  it('客户端不再存模型价格（以前 data/models.ts 里有一份 USD 报价）', () => {
    const clientData = join(here, '..', '..', '..', 'client', 'src', 'data', 'models.ts')
    const text = readFileSync(clientData, 'utf8')
    expect(text).not.toMatch(/inputPrice\s*:/)
    expect(text).not.toMatch(/outputPrice\s*:/)
  })
})
