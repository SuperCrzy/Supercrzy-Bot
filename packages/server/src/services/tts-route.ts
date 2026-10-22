/**
 * TTS 出口自动选路（2026-10-21）。
 *
 * 为什么需要：Edge TTS 本身是 Akamai 前置，**国际用户就近接入只要 0.2~0.5s**；
 * 但从中国大陆出口这条路实测 1.5~30s（手机热点更差）。加一个就近中继能把它拉回 1s 级。
 * 但中继对国际用户是**反向优化**（多绕一跳），所以不能写死，必须**按实际握手耗时选**。
 *
 * 规则（刻意保守）：
 *   · 候选 = 直连 + `TTS_RELAYS` 里配置的每个中继（逗号分隔，`http://host:port`）
 *   · 逐个测「ws 握手到底要多久」，取最快的
 *   · **中继必须比直连快 30% 以上才切** —— 否则宁可直连，少一跳少一处故障
 *   · `TTS_PROXY` 手工指定时直接用它，不做探测（人工优先）
 *   · 结果缓存 10 分钟；失败时可以用 `POST /api/tts/route/refresh` 强制重测
 */
import { randomBytes } from 'node:crypto'
import { openUpstream } from './tts'
import {
  getChosenRelay,
  getProbes,
  hasChosenRelay,
  resetRouteState,
  setChosenRelay,
  setProbes,
  type RouteProbe,
} from './tts-route-state'

/** 选路结果的有效期 */
export const ROUTE_TTL_MS = 10 * 60_000
/**
 * 单次探测预算。
 *
 * 与 `TTS_HANDSHAKE_TIMEOUT_MS`（12s）对齐：探测用的是同一条握手路径，
 * 给它更短的预算会**在坏链路上把"能用但慢"误判成"不能用"**（实测踩过：
 * 手机经中继 20s 首字节，8s 预算下探针直接超时，于是路由永远不选它）。
 */
export const ROUTE_PROBE_TIMEOUT_MS = 12_000
/** 每个候选采样次数：链路抖动大时单次结果不可信，取中位数 */
export const ROUTE_PROBE_SAMPLES = 3
/** 中继要比直连快这么多才算"值得绕一跳" */
export const ROUTE_IMPROVE_RATIO = 0.7

export function relayCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = String(env.TTS_RELAYS || '').trim()
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s))
}

/** 手工指定了 TTS_PROXY → 不探测，直接用 */
function manualProxy(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = String(env.TTS_PROXY || '').trim()
  return /^https?:\/\//i.test(raw) ? raw : null
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 探测超时`)), ms)
    if (typeof t.unref === 'function') t.unref()
    p.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

/** 测一个候选的握手耗时（`null` = 直连） */
async function probeOne(candidate: string | null): Promise<RouteProbe> {
  const t0 = Date.now()
  const connectionId = randomBytes(16).toString('hex')
  const pending = openUpstream(connectionId, candidate)
  let settled = false
  // 探测超时后 socket 可能仍会建起来 —— 建起来就立刻关掉，别留在池子外
  pending.then((s) => { if (settled) { try { s.close() } catch { /* 已关 */ } } }).catch(() => {})
  try {
    const sock = await withTimeout(pending, ROUTE_PROBE_TIMEOUT_MS, candidate ?? 'direct')
    settled = true
    try { sock.close() } catch { /* 已关 */ }
    return { candidate: candidate ?? 'direct', ms: Date.now() - t0 }
  } catch (e: any) {
    settled = true
    return { candidate: candidate ?? 'direct', ms: null, error: e?.message || String(e) }
  }
}

export interface RouteDecision {
  /** 选中的中继（undefined = 直连） */
  proxy?: string
  /** 选中候选的握手耗时 */
  ms: number
  probes: RouteProbe[]
}

let picking: Promise<RouteDecision> | null = null

/**
 * 选一条最快的出口。并发安全（同时多次调用复用同一次探测）。
 * `force` = 忽略缓存与 TTL，强制重测。
 */
export async function pickTtsRoute(force = false): Promise<RouteDecision> {
  const manual = manualProxy()
  if (manual) {
    const d: RouteDecision = { proxy: manual, ms: 0, probes: [{ candidate: manual, ms: 0 }] }
    setChosenRelay(manual)
    return d
  }
  if (!force && hasChosenRelay() && Date.now() - getProbes().at < ROUTE_TTL_MS) {
    const cached = getProbes()
    const best = [...cached.probes].filter((p) => p.ms !== null).sort((a, b) => (a.ms! - b.ms!))[0]
    return { proxy: getChosenRelay(), ms: best?.ms ?? 0, probes: cached.probes }
  }
  if (picking) return picking

  picking = (async () => {
    const candidates: (string | null)[] = [null, ...relayCandidates()]
    // 每个候选并行采 3 次、取中位数：跨太平洋链路单次抖动可以从 1s 跳到 20s，
    // 只测一次就决定"未来 10 分钟走哪条路"太草率了。
    const probes = await Promise.all(
      candidates.map(async (c) => {
        const rounds = await Promise.all(Array.from({ length: ROUTE_PROBE_SAMPLES }, () => probeOne(c)))
        const okMs = rounds.map((r) => r.ms).filter((v): v is number => v !== null).sort((a, b) => a - b)
        if (!okMs.length) {
          return { candidate: rounds[0].candidate, ms: null, error: rounds[0].error ?? '全部采样失败' }
        }
        const median = okMs[Math.floor(okMs.length / 2)]
        return { candidate: rounds[0].candidate, ms: median }
      }),
    )
    setProbes(probes)

    const ok = probes.filter((p) => p.ms !== null).sort((a, b) => (a.ms! - b.ms!))
    if (!ok.length) {
      // 全挂：保持直连（至少还能报错给用户），下次再测
      setChosenRelay(undefined)
      return { proxy: undefined, ms: 0, probes }
    }
    const best = ok[0]
    const direct = probes.find((p) => p.candidate === 'direct')
    let chosen: string | undefined
    if (best.candidate === 'direct') {
      chosen = undefined
    } else {
      // 中继只有明显更快（直连失败，或快 30% 以上）才值得绕
      const directMs = direct?.ms
      const worth = directMs === null || directMs === undefined || best.ms! < directMs * ROUTE_IMPROVE_RATIO
      chosen = worth ? best.candidate : undefined
    }
    setChosenRelay(chosen)
    return { proxy: chosen, ms: best.ms!, probes }
  })()

  try {
    return await picking
  } finally {
    picking = null
  }
}

/** 供诊断端点用 */
export function routeSnapshot() {
  const { probes, at } = getProbes()
  return {
    chosen: getChosenRelay() ?? 'direct',
    relays: relayCandidates(),
    manual: manualProxy(),
    probes,
    probedAt: at,
    ttlMs: ROUTE_TTL_MS,
  }
}

export { resetRouteState }
