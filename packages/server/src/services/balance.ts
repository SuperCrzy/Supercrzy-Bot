/**
 * API 余额（2026-10-22）
 *
 * 老板要的是「用量页能直接看到还剩多少钱，余额低于 5 块提醒充值」。
 *
 * 关键约束：
 * 1. **API key 绝不下发前端**。查询只能在后端做，前端只拿汇总数字。
 * 2. DeepSeek 官方有 `GET /user/balance`（与 chat 同一把 key），返回的金额是**字符串**，
 *    形如 { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.00",
 *    granted_balance: "10.00", topped_up_balance: "100.00" }] }。
 * 3. **订阅制没有余量查询接口**（官方没提供配额 API），所以这里只对「按量付费」能给出数字；
 *    查不了就返回 supported=false 并说明原因，不许瞎显示 0。
 * 4. 5 分钟内存缓存：用量页每打开一次就打一次上游不礼貌，也容易撞限流。
 */
import { getLLMConfig, normalizeBaseUrl } from './llm-config'

/** 余额低于这个值（¥）就算低余额，前端提示充值 */
export const LOW_BALANCE_THRESHOLD_CNY = 5

const CACHE_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

export interface BalanceEntry {
  currency: string
  /** 总余额 */
  total: number
  /** 赠送余额 */
  granted: number
  /** 充值余额 */
  toppedUp: number
}

export interface BalanceResult {
  /** 当前 provider 是否支持余额查询 */
  supported: boolean
  provider: 'deepseek' | 'other'
  /** 上游是否标记账户可用（欠费/停用时为 false） */
  isAvailable: boolean
  balances: BalanceEntry[]
  fetchedAt: string
  /** 低余额判定所需的阈值（¥）；无人民币账户时也按折算后的金额比 */
  thresholdCny: number
  /** 是否低于阈值 */
  low: boolean
  /** supported=false 或查询失败时的原因，前端直出一句人话 */
  note?: string
  /** 命中缓存的时间戳（调试用，便于确认没有每次打上游） */
  cached?: boolean
}

const EMPTY = (note: string, provider: 'deepseek' | 'other' = 'other'): BalanceResult => ({
  supported: false,
  provider,
  isAvailable: false,
  balances: [],
  fetchedAt: new Date().toISOString(),
  thresholdCny: LOW_BALANCE_THRESHOLD_CNY,
  low: false,
  note,
})

/** 只有官方 DeepSeek 域名才谈得上余额接口；第三方中转/自建网关一律不支持 */
export function isDeepSeekBase(baseUrl: string): boolean {
  return /(^|\.)deepseek\.com/i.test(String(baseUrl || ''))
}

function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  // 官方返回字符串金额（"110.00"），不能直接当数字用
  const n = Number(String(v ?? '').trim())
  return Number.isFinite(n) ? n : 0
}

/**
 * 解析余额响应。抽成纯函数是为了能测：上游金额是字符串、currency 可能是 USD，
 * 这两点任一处理错，页面就会显示 0 元或把美元当人民币。
 */
export function parseBalancePayload(payload: any): { isAvailable: boolean; balances: BalanceEntry[] } {
  const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : []
  const balances: BalanceEntry[] = infos
    .map((b: any) => ({
      currency: String(b?.currency || '').toUpperCase() || 'UNKNOWN',
      total: num(b?.total_balance),
      granted: num(b?.granted_balance),
      toppedUp: num(b?.topped_up_balance),
    }))
    .filter((b: BalanceEntry) => b.currency !== 'UNKNOWN')
  return { isAvailable: payload?.is_available === true, balances }
}

/**
 * 折算出「够不够 5 块钱」用的金额。
 * 优先用人民币账户；只有美元账户时按 7.2 折算（与计价同一汇率常量口径，见 model-pricing）。
 */
export function cnyEquivalent(balances: BalanceEntry[], usdToCny = 7.2): number | null {
  if (!balances.length) return null
  const cny = balances.find((b) => b.currency === 'CNY')
  if (cny) return cny.total
  const usd = balances.find((b) => b.currency === 'USD')
  if (usd) return usd.total * usdToCny
  return null
}

let cache: { at: number; result: BalanceResult } | null = null

/** 清缓存（设置页改了 key / 测试用） */
export function clearBalanceCache(): void {
  cache = null
}

/**
 * 查余额。失败不抛异常——用量页是只读展示，查不到就说明原因，
 * 不能让一个展示性问题把整页打挂。
 */
export async function getBalance(opts: { force?: boolean; now?: number } = {}): Promise<BalanceResult> {
  const now = opts.now ?? Date.now()
  if (!opts.force && cache && now - cache.at < CACHE_TTL_MS) {
    return { ...cache.result, cached: true }
  }

  let cfg: { baseUrl: string; apiKey: string }
  try {
    cfg = getLLMConfig()
  } catch {
    const r = EMPTY('读取本地配置失败，无法查询余额')
    return r
  }

  if (!isDeepSeekBase(cfg.baseUrl)) {
    return EMPTY('当前 API 地址不是 DeepSeek 官方端点，没有余额查询接口')
  }
  if (!cfg.apiKey) {
    return EMPTY('还没有配置 API Key', 'deepseek')
  }

  const url = `${normalizeBaseUrl(cfg.baseUrl)}/user/balance`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!resp.ok) {
      // 不回显响应体：其中可能带 key 片段或账户信息
      const note = resp.status === 401 || resp.status === 403
        ? `API Key 被拒（HTTP ${resp.status}），无法查询余额`
        : `余额接口返回 HTTP ${resp.status}`
      return { ...EMPTY(note, 'deepseek'), fetchedAt: new Date(now).toISOString() }
    }
    const payload = await resp.json()
    const { isAvailable, balances } = parseBalancePayload(payload)
    if (!balances.length) {
      return { ...EMPTY('该账户没有返回余额明细（可能是订阅制或企业账户）', 'deepseek'), isAvailable }
    }
    const cny = cnyEquivalent(balances)
    const result: BalanceResult = {
      supported: true,
      provider: 'deepseek',
      isAvailable,
      balances,
      fetchedAt: new Date(now).toISOString(),
      thresholdCny: LOW_BALANCE_THRESHOLD_CNY,
      low: cny !== null && cny < LOW_BALANCE_THRESHOLD_CNY,
      note: isAvailable ? undefined : '账户当前不可用（可能已欠费或被停用）',
    }
    cache = { at: now, result }
    return result
  } catch (err: any) {
    const aborted = err?.name === 'AbortError'
    return {
      ...EMPTY(aborted ? '余额接口超时' : '余额接口连接失败', 'deepseek'),
      fetchedAt: new Date(now).toISOString(),
    }
  } finally {
    clearTimeout(timer)
  }
}
