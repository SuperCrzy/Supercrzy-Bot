/**
 * 思考过程展示策略（阶段三-⑤，2026-09-16）
 *
 * 背景：reasoning 有三段生命周期，各自应有不同默认值——
 *   ① 流式中（未完成）：推理还在长，面板最长 360px 且自动滚动，是"首屏被思考占满"的主因
 *   ② 已完成：结论已产出，思考必须让位（首屏只留"结论 + 关键动作"）
 *   ③ 完全不显示：由既有设置项 showReasoning 承担（服务端持久化），本模块不重复定义
 *
 * 因此本模块只解决 ① 的默认值，并保证 ② 恒折叠。
 *
 * 硬约束（继承 2026-08-26 折叠状态机教训）：
 * 默认值只在组件挂载那一刻折算一次，之后只由用户点击改变。
 * 绝不随 thinking_chunk / tool_call 等流式事件中途改写 liveOpen——
 * 那正是"打字机框随回复长短反复伸缩"的根因（高度在 61~441px 往返震荡 6 次）。
 * 所以本模块只导出纯函数 + 一个不订阅任何事件的单例 ref。
 */

import { ref, type Ref } from 'vue'

/** 流式思考的默认形态：折叠成一行（默认） / 展开实时推理 */
export type ReasoningLiveMode = 'folded' | 'expanded'

export const REASONING_MODE_KEY = 'supercrzy:reasoningDisplay'

/** 默认折叠：首屏只呈现结论与关键动作，思考按需展开（阶段三-⑤） */
export const DEFAULT_REASONING_MODE: ReasoningLiveMode = 'folded'

const MODES: ReasoningLiveMode[] = ['folded', 'expanded']

export type ReasoningStorage = Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem'>>

/** 默认存储探测：浏览器/Electron 用 localStorage；node（SSR / 单测）下为 undefined */
function detectStorage(): ReasoningStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

let storageProvider: () => ReasoningStorage | undefined = detectStorage

/**
 * 注入存储实现（非浏览器环境 / 单测用）。传 undefined 恢复默认探测。
 * 之所以留这个缝：客户端单测环境是 node，没有 localStorage；持久化是功能的一部分，
 * 不能因为环境缺失就变成不可测的死代码。
 */
export function setReasoningStorage(fn?: () => ReasoningStorage | undefined): void {
  storageProvider = fn ?? detectStorage
}

/** 容错归一：任何非法值（含旧数据、手改 localStorage）一律回落到默认 */
export function normalizeReasoningMode(raw: unknown): ReasoningLiveMode {
  return MODES.includes(raw as ReasoningLiveMode) ? (raw as ReasoningLiveMode) : DEFAULT_REASONING_MODE
}

/** 读取偏好（无存储 / 抛异常 → 默认值，绝不阻塞渲染） */
export function readReasoningMode(storage?: ReasoningStorage): ReasoningLiveMode {
  try {
    const s = storage ?? storageProvider()
    if (!s) return DEFAULT_REASONING_MODE
    return normalizeReasoningMode(s.getItem(REASONING_MODE_KEY))
  } catch {
    return DEFAULT_REASONING_MODE
  }
}

/** 写入偏好（失败静默：偏好丢失不影响功能） */
export function writeReasoningMode(mode: ReasoningLiveMode, storage?: ReasoningStorage): void {
  const safe = normalizeReasoningMode(mode)
  try {
    const s = storage ?? storageProvider()
    s?.setItem?.(REASONING_MODE_KEY, safe)
  } catch {
    /* ignore */
  }
}

/** 流式思考默认是否展开 */
export function defaultLiveOpen(mode: ReasoningLiveMode): boolean {
  return normalizeReasoningMode(mode) === 'expanded'
}

/**
 * 完成态默认是否展开：恒 false。
 * 完成即让位——与 ThinkingGroup（多轮聚合）一致，首屏不因历史推理变长。
 */
export function defaultCompletedOpen(): boolean {
  return false
}

/** 两档循环（设置页开关用） */
export function nextReasoningMode(mode: ReasoningLiveMode): ReasoningLiveMode {
  return normalizeReasoningMode(mode) === 'folded' ? 'expanded' : 'folded'
}

// ============ 单例响应式偏好（设置页写入 → 思考面板即时生效） ============

const liveExpanded = ref(defaultLiveOpen(readReasoningMode()))

/**
 * 全局共享的"流式思考是否展开"偏好。
 * 注意：只用于「组件挂载时的初值」，不要在流式事件里读它去改状态。
 */
export function useReasoningDisplay(): {
  liveExpanded: Ref<boolean>
  setLiveExpanded: (v: boolean) => void
} {
  function setLiveExpanded(v: boolean) {
    liveExpanded.value = !!v
    writeReasoningMode(v ? 'expanded' : 'folded')
  }
  return { liveExpanded, setLiveExpanded }
}
