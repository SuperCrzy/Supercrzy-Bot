/**
 * 出口自动选路（2026-10-21）。
 *
 * 为什么值得单测：这段逻辑决定"要不要绕一跳中继"，判错的代价两头都难看 ——
 * 该绕不绕 ⇒ 大陆用户继续 7~30s；不该绕却绕 ⇒ 国际用户平白多一跳。
 * 这里把 `openUpstream` 换成可控延迟的替身，逐一钉住四条规则。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ delays: new Map<string, number>(), fail: new Set<string>(), calls: [] as string[] }))

vi.mock('./tts', () => ({
  openUpstream: async (_id: string, proxy?: string | null) => {
    const key = proxy ?? 'direct'
    h.calls.push(key)
    const d = h.delays.get(key) ?? 10
    if (h.fail.has(key)) throw new Error(`connect failed: ${key}`)
    await new Promise((r) => setTimeout(r, d))
    return { on() {}, send() {}, close() {}, pause() {}, resume() {} } as any
  },
}))

import { pickTtsRoute, relayCandidates, fetchRelayManifest, ROUTE_IMPROVE_RATIO, routeSnapshot } from './tts-route'
import { resetRouteState } from './tts-route-state'

beforeEach(() => {
  h.delays.clear(); h.fail.clear(); h.calls = []
  resetRouteState()
  delete process.env.TTS_RELAYS
  delete process.env.TTS_PROXY
  delete process.env.TTS_RELAY_MANIFEST
  // Unit tests never touch the network: a failed manifest fetch yields an empty list (individual
  // cases override fetch themselves)
  globalThis.fetch = (async () => { throw new Error('offline in unit test') }) as any
})
afterEach(() => {
  delete process.env.TTS_RELAYS
  delete process.env.TTS_PROXY
})

describe('中继候选解析', () => {
  it('只认 http/https，逗号分隔，空串忽略', () => {
    process.env.TTS_RELAYS = 'http://a:1, socks5://b:2 ,https://c:3,'
    expect(relayCandidates()).toEqual(['http://a:1', 'https://c:3'])
  })
  it('未配置时返回空数组（默认直连）', () => {
    expect(relayCandidates()).toEqual([])
  })
})

describe('选路规则', () => {
  it('直连最快 → 选直连（国际用户的常态）', async () => {
    process.env.TTS_RELAYS = 'http://relay:3128'
    h.delays.set('direct', 20)
    h.delays.set('http://relay:3128', 200)
    const d = await pickTtsRoute(true)
    expect(d.proxy).toBeUndefined()
    expect(routeSnapshot().chosen).toBe('direct')
  })

  it('中继比直连快 30% 以上 → 选它（大陆用户的常态）', async () => {
    process.env.TTS_RELAYS = 'http://relay:3128'
    h.delays.set('direct', 1000)
    h.delays.set('http://relay:3128', 300)
    const d = await pickTtsRoute(true)
    expect(d.proxy).toBe('http://relay:3128')
    expect(300).toBeLessThan(1000 * ROUTE_IMPROVE_RATIO)
  })

  it('中继只快一点点（没到 30%）→ 仍选直连，不多绕一跳', async () => {
    process.env.TTS_RELAYS = 'http://relay:3128'
    h.delays.set('direct', 300)
    h.delays.set('http://relay:3128', 280)
    const d = await pickTtsRoute(true)
    expect(d.proxy).toBeUndefined()
  })

  it('直连失败 + 中继可用 → 选中继（否则用户直接没声音）', async () => {
    process.env.TTS_RELAYS = 'http://relay:3128'
    h.fail.add('direct')
    h.delays.set('http://relay:3128', 120)
    const d = await pickTtsRoute(true)
    expect(d.proxy).toBe('http://relay:3128')
  })

  it('全部失败 → 保持直连（让上层报错，而不是假装有路）', async () => {
    process.env.TTS_RELAYS = 'http://relay:3128'
    h.fail.add('direct'); h.fail.add('http://relay:3128')
    const d = await pickTtsRoute(true)
    expect(d.proxy).toBeUndefined()
    expect(d.probes.every((p) => p.ms === null)).toBe(true)
  })

  it('手工 TTS_PROXY 优先，且不探测', async () => {
    process.env.TTS_PROXY = 'http://manual:3128'
    process.env.TTS_RELAYS = 'http://relay:3128'
    const d = await pickTtsRoute(true)
    expect(d.proxy).toBe('http://manual:3128')
    expect(h.calls).toEqual([]) // 一次探测都不该发生
  })
})

/**
 * Runtime relay manifest delivery.
 *
 * Why "a failure is non-fatal" must be pinned: the env of installed apps has no TTS_RELAYS, so the
 * relay address can only come from the manifest; if this threw whenever the manifest site is down,
 * the **whole reading chain would go down with it** — turning an optimization into a failure point.
 */
describe('运行时中继清单', () => {
  it('env TTS_RELAYS 手工配置优先 → 根本不发清单请求', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; return { ok: true, json: async () => ({ relays: ['http://from-manifest:1'] }) } as any }) as any
    const r = await fetchRelayManifest({ TTS_RELAYS: 'http://env-relay:3128' } as any)
    expect(r).toEqual(['http://env-relay:3128'])
    expect(calls).toBe(0)
  })

  it('无 env → 拉清单并解析 relays[]；非法项过滤', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ relays: ['http://relay:3128', 'socks5://bad:1', ''] }),
    }) as any) as any
    const r = await fetchRelayManifest({} as any, true)
    expect(r).toEqual(['http://relay:3128'])
  })

  it('拉取失败非致命 → 返回空数组（回直连），绝不抛错', async () => {
    globalThis.fetch = (async () => { throw new Error('network down') }) as any
    await expect(fetchRelayManifest({} as any, true)).resolves.toEqual([])
  })

  it('缓存 10 分钟：不带 force 的重复调用不再打网络', async () => {
    let n = 0
    globalThis.fetch = (async () => { n++; return { ok: true, json: async () => ({ relays: ['http://c:1'] }) } as any }) as any
    await fetchRelayManifest({} as any, true) // 写缓存
    n = 0
    expect(await fetchRelayManifest({} as any)).toEqual(['http://c:1'])
    expect(await fetchRelayManifest({} as any)).toEqual(['http://c:1'])
    expect(n).toBe(0)
  })
})
