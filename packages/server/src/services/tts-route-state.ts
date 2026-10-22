/**
 * TTS 出口选路的共享状态（2026-10-21）。
 *
 * 为什么单独成一个模块：`tts.ts`（用选路结果）和 `tts-route.ts`（算选路结果）
 * 必须共享这份状态，但**不能互相 import** —— 否则形成环（route 要 openUpstream，
 * tts 要 chosenRelay）。把状态抽出来，两边都只依赖它。
 */

/** 当前选中的中继（`undefined` = 直连）。`null` = 还没探测过 */
let chosenRelay: string | undefined | null = null
/** 最近一次探测的明细（诊断端点用） */
export interface RouteProbe {
  /** 候选标识：`direct` 或中继 URL */
  candidate: string
  /** 握手耗时（ms）；`null` = 失败 */
  ms: number | null
  /** 失败原因（有值时 ms 必为 null） */
  error?: string
}
let lastProbes: RouteProbe[] = []
let lastProbeAt = 0

export function getChosenRelay(): string | undefined {
  return chosenRelay === null ? undefined : chosenRelay
}

/** 是否已探测过（false 时调用方应触发一次探测） */
export function hasChosenRelay(): boolean {
  return chosenRelay !== null
}

export function setChosenRelay(relay: string | undefined): void {
  // undefined = 直连（已探测且判定直连更快），null = 还没探测过 —— 两者语义不同
  chosenRelay = relay
}

export function setProbes(probes: RouteProbe[]): void {
  lastProbes = probes
  lastProbeAt = Date.now()
}

export function getProbes(): { probes: RouteProbe[]; at: number } {
  return { probes: lastProbes, at: lastProbeAt }
}

/**
 * 把路由判定标记为过期（2026-10-21）。
 *
 * 用在**朗读真的失败之后**：链路可能在两次探测之间变坏（跨太平洋链路就这样），
 * 不失效的话会拿着 10 分钟前的结论继续走死路。下一次 `pickTtsRoute()` 会自动重测。
 */
export function invalidateRoute(): void {
  lastProbeAt = 0
}

/** 仅供单测：把状态复位成"未探测" */
export function resetRouteState(): void {
  chosenRelay = null
  lastProbes = []
  lastProbeAt = 0
}
