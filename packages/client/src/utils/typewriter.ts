/**
 * 统一打字机引擎（主流实现 conversation-render streaming-text 同款）。
 *
 * 模型：目标 = 流式到达的完整文本；显示 = displayLength 逐步揭示。
 * 每帧（targetIntervalMs）按非对称 EMA 平滑滞后（lag = 目标 - 已显示）：
 * - lag 增大 → accelFactor 加速追赶（网络突发不喷射）
 * - lag 接近 → decelFactor 减速收尾（速度稳定不抖动）
 * - 每帧吐 clamp(emaLag / speedDivisor, min, max) 个字符 → 恒定速度的"打字机"
 * 正文与思考共用同一引擎，速度一致可调。
 */

export interface TypewriterState {
  /** 已揭示字符数（相对当前目标文本） */
  displayLength: number
  /** 平滑后的滞后量（EMA） */
  emaLag: number
}

export interface TypewriterConfig {
  /** 帧间隔（ms）：40ms ≈ 25fps */
  targetIntervalMs: number
  /** 速度除数：每帧吐 emaLag / speedDivisor 字符 */
  speedDivisor: number
  /** 每帧最少字符 */
  minCharsPerTick: number
  /** 每帧最多字符（40ms/1-4 字符 ≈ 25-100 字符/秒） */
  maxCharsPerTick: number
  /** 追赶加速系数（lag 增大时） */
  accelFactor: number
  /** 收尾减速系数（lag 接近时） */
  decelFactor: number
  /** 滞后小于该值时一次性吐完剩余 */
  fastDrainThreshold: number
}

/** 主流实现 STREAMING_TEXT_BUFFER_CONFIG 原参数 */
export const DEFAULT_TYPING_CONFIG: TypewriterConfig = {
  targetIntervalMs: 40,
  speedDivisor: 28,
  minCharsPerTick: 1,
  maxCharsPerTick: 4,
  accelFactor: 0.2,
  decelFactor: 0.08,
  fastDrainThreshold: 0,
}

/** 避免把一个 emoji 的代理对（surrogate pair）从中间切断（主流实现 avoidSurrogateSplit 同款） */
export function avoidSurrogateSplit(text: string, length: number): number {
  const clamped = Math.max(0, Math.min(length, text.length))
  if (clamped <= 0) return 0
  const prevCode = text.charCodeAt(clamped - 1)
  if (!(prevCode >= 0xd800 && prevCode <= 0xdbff)) return clamped
  const nextCode = clamped < text.length ? text.charCodeAt(clamped) : NaN
  return nextCode >= 0xdc00 && nextCode <= 0xdfff ? clamped + 1 : clamped - 1
}

/**
 * 计算下一帧应显示的长度。纯函数（主流实现 advanceReveal 同款）：
 * 给定当前状态 + 目标文本长度，返回新状态。
 */
export function advanceReveal(
  state: TypewriterState,
  targetLength: number,
  targetText: string,
  config: TypewriterConfig,
): TypewriterState {
  const lag = targetLength - state.displayLength
  // 目标未增长/已追上：不推进，emaLag 向 0 衰减（供空转衔接）
  if (lag <= 0) {
    return {
      displayLength: Math.min(state.displayLength, targetLength),
      emaLag: state.emaLag * (1 - config.decelFactor),
    }
  }
  // 滞后极小：一次性吐完剩余
  if (lag <= config.fastDrainThreshold) {
    return { displayLength: targetLength, emaLag: 0 }
  }
  // 非对称 EMA：滞后增大加速、收窄减速
  const factor = lag > state.emaLag ? config.accelFactor : config.decelFactor
  const nextEmaLag = state.emaLag + (lag - state.emaLag) * factor
  const raw = Math.floor(nextEmaLag / config.speedDivisor)
  const reveal = Math.max(config.minCharsPerTick, Math.min(raw, config.maxCharsPerTick))
  const target = state.displayLength + reveal
  return {
    displayLength: avoidSurrogateSplit(targetText, target),
    emaLag: nextEmaLag,
  }
}

/** 初始状态 */
export function createTypewriterState(): TypewriterState {
  return { displayLength: 0, emaLag: 0 }
}
