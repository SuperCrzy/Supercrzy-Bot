/**
 * API 余额查询（2026-10-22）
 *
 * 三个容易踩的点，全部钉住：
 * 1. **key 绝不能出现在响应里**。余额查询走服务端，前端只拿数字；响应体一旦带 key，
 *    等于把它写进浏览器历史和前端日志。
 * 2. **官方金额是字符串**（"110.00"）。当数字用会得到 NaN → 页面显示 0 元 → 用户以为没钱了。
 * 3. **订阅制/第三方网关没有余额接口**。必须 supported=false + 说明，不能返回 0。
 *
 * 另外钉 5 分钟缓存：用量页每打开一次就打上游会撞限流。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const REAL_KEY = 'sk-testkey1234567890abcdef'

// 先设 env，再 import（config 在模块加载时求值）
const wsRoot = mkdtempSync(join(tmpdir(), 'supercrzy-balance-ws-'))
process.env.WORKSPACE_DIR = wsRoot
process.env.DB_PATH = join(tmpdir(), `supercrzy-balance-${Date.now()}.db`)
process.env.OPENAI_KEY = REAL_KEY

const { parseBalancePayload, cnyEquivalent, isDeepSeekBase, getBalance, clearBalanceCache, LOW_BALANCE_THRESHOLD_CNY } =
  await import('./balance')
const { initDatabase } = await import('./database')

// getBalance 要读 settings 表拿 key/endpoint —— 不建库就只会返回「读取本地配置失败」
beforeAll(() => {
  initDatabase()
})

afterAll(() => {
  rmSync(wsRoot, { recursive: true, force: true })
})

const okPayload = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
}

function mockFetchOnce(payload: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  clearBalanceCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearBalanceCache()
})

describe('解析余额响应', () => {
  it('字符串金额被正确转成数字（官方就是字符串）', () => {
    const { balances, isAvailable } = parseBalancePayload(okPayload)
    expect(isAvailable).toBe(true)
    expect(balances).toHaveLength(1)
    expect(balances[0]).toEqual({ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 })
  })

  it('脏值/缺字段不会变成 NaN', () => {
    const { balances } = parseBalancePayload({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: 'abc' }, { currency: 'USD' }],
    })
    expect(balances.every((b: any) => Number.isFinite(b.total))).toBe(true)
    expect(balances.every((b: any) => Number.isFinite(b.granted) && Number.isFinite(b.toppedUp))).toBe(true)
  })

  it('无 currency 的条目被丢弃（不允许出现空币种行）', () => {
    const { balances } = parseBalancePayload({ balance_infos: [{ total_balance: '9.9' }] })
    expect(balances).toHaveLength(0)
  })

  it('is_available 缺省/非 true 视为不可用', () => {
    expect(parseBalancePayload({}).isAvailable).toBe(false)
    expect(parseBalancePayload({ is_available: 'true' }).isAvailable).toBe(false)
  })

  it('只有 USD 账户时按汇率折算人民币（不能把 $3 当成 ¥3）', () => {
    const usd = [{ currency: 'USD', total: 3, granted: 0, toppedUp: 3 }]
    expect(cnyEquivalent(usd, 7.2)).toBeCloseTo(21.6, 6)
    expect(cnyEquivalent(usd, 7.2)! < LOW_BALANCE_THRESHOLD_CNY).toBe(false)
  })

  it('CNY 账户优先于 USD 账户', () => {
    const both = [
      { currency: 'USD', total: 1, granted: 0, toppedUp: 1 },
      { currency: 'CNY', total: 50, granted: 0, toppedUp: 50 },
    ]
    expect(cnyEquivalent(both)).toBe(50)
  })

  it('空列表 → null（前端据此显示「不支持」而不是 0）', () => {
    expect(cnyEquivalent([])).toBeNull()
  })
})

describe('端点判定', () => {
  it('只认官方域名', () => {
    expect(isDeepSeekBase('https://api.deepseek.com')).toBe(true)
    expect(isDeepSeekBase('https://api.deepseek.com/v1')).toBe(true)
    expect(isDeepSeekBase('https://my-proxy.example.com/deepseek')).toBe(false)
    expect(isDeepSeekBase('https://notdeepseek.com')).toBe(false)
  })
})

describe('查询流程', () => {
  it('🔴 API key 不出现在响应里', async () => {
    mockFetchOnce(okPayload)
    const r = await getBalance({ force: true })
    const json = JSON.stringify(r)
    expect(json).not.toContain(REAL_KEY)
    expect(json).not.toContain('sk-test')
  })

  it('请求带 Bearer 头，且打到 /user/balance', async () => {
    const fn = mockFetchOnce(okPayload)
    await getBalance({ force: true })
    const [url, init] = fn.mock.calls[0] as any
    expect(String(url)).toMatch(/\/user\/balance$/)
    expect((init as any).headers.Authorization).toBe(`Bearer ${REAL_KEY}`)
  })

  it('正常账户：supported=true，余额与 low 状态正确', async () => {
    mockFetchOnce(okPayload)
    const r = await getBalance({ force: true })
    expect(r.supported).toBe(true)
    expect(r.provider).toBe('deepseek')
    expect(r.balances[0].total).toBe(110)
    expect(r.low).toBe(false)
    expect(r.thresholdCny).toBe(LOW_BALANCE_THRESHOLD_CNY)
  })

  it('🔴 低于 5 元 → low=true（充值提醒的数据源）', async () => {
    mockFetchOnce({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '4.99' }] })
    const r = await getBalance({ force: true })
    expect(r.supported).toBe(true)
    expect(r.low).toBe(true)
  })

  it('恰好 5 元不触发（边界：不是「低于等于」）', async () => {
    mockFetchOnce({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '5.00' }] })
    const r = await getBalance({ force: true })
    expect(r.low).toBe(false)
  })

  it('空余额明细 → supported=false 并给出原因（订阅制/企业账户），不显示 0', async () => {
    mockFetchOnce({ is_available: true, balance_infos: [] })
    const r = await getBalance({ force: true })
    expect(r.supported).toBe(false)
    expect(r.balances).toEqual([])
    expect(r.note).toBeTruthy()
  })

  it('401 不把响应体透给前端，只给一句人话', async () => {
    mockFetchOnce({ error: { message: 'Authentication Fails, Your api key is invalid' } }, 401)
    const r = await getBalance({ force: true })
    expect(r.supported).toBe(false)
    expect(r.note).toContain('401')
    expect(JSON.stringify(r)).not.toContain('Authentication Fails')
  })

  it('5 分钟缓存：第二次不打上游', async () => {
    const fn = mockFetchOnce(okPayload)
    await getBalance({ now: 1_000_000 })
    const second = await getBalance({ now: 1_000_000 + 60_000 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(second.cached).toBe(true)
  })

  it('缓存过期后重新查询', async () => {
    const fn = mockFetchOnce(okPayload)
    await getBalance({ now: 1_000_000 })
    await getBalance({ now: 1_000_000 + 5 * 60 * 1000 + 1 })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('force 跳过缓存', async () => {
    const fn = mockFetchOnce(okPayload)
    await getBalance({ now: 1_000_000 })
    await getBalance({ force: true, now: 1_000_000 + 1 })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('网络异常不抛出去（用量页不能因为查余额而白屏）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const r = await getBalance({ force: true })
    expect(r.supported).toBe(false)
    expect(r.note).toBeTruthy()
  })
})
