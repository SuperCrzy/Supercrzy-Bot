/**
 * 模型上下文窗口（tokens）—— 内置映射的**单一来源**（2026-10-22 从 agent.ts 抽出）
 *
 * 为什么搬出来：这段逻辑此前埋在 `agent.ts` 里，测它要拖进整个 agent（依赖 playbook /
 * skill-loader / sandbox…），于是长期只有"真机看环"这一种验证方式 —— 而环的分母错了
 * 半年没人发现。抽成纯函数后可以直接钉断言。
 *
 * 优先级（`resolveContextWindow`）：用户配的 DB 值 &gt; 内置映射 &gt; 默认 128K。
 */

export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * 内置映射（按顺序匹配，**先命中先返回**）。
 *
 * ⚠️ 顺序是语义：`deepseek-v4` / `deepseek-flash` 必须排在通用 `deepseek` 之前，
 *    否则 1M 的两条永远轮不到。
 */
export const MODEL_CONTEXT_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/gemini/i, 1_000_000],
  [/grok/i, 1_000_000],
  [/qwen/i, 1_000_000],
  [/glm-4\.6/i, 200_000],
  [/claude/i, 200_000],
  [/gpt-4\.1/i, 1_000_000],
  [/kimi/i, 128_000],
  // 🔴 2026-10-22：DeepSeek-V4 全系 CONTEXT LENGTH = 1M（官方 Models & Pricing：
  //   deepseek-v4-pro / deepseek-v4-flash 都是 1M，MAX OUTPUT 384K）。
  //   此前 `/deepseek/i → 128_000` 一刀切，导致 ① 顶部环分母错（468K 显示成 366%）；
  //   ② `shouldCompress` 阈值 = window × 0.55 ⇒ **70.4K 就压缩**，1M 能力只用了 7%。
  [/deepseek-v4/i, 1_048_576],
  // 官方新名 deepseek-flash = DeepSeek-V4.1-Flash，同样 1M；legacy 名 v4-flash 由上面覆盖
  [/^deepseek-flash$/i, 1_048_576],
  // v3.x / r1 / chat 等旧世代真的是 128K —— 不要跟着 V4 一起放大
  [/deepseek/i, 128_000],
  [/moonshot/i, 128_000],
]

/** 只查内置映射（不含 DB 覆盖），未命中返回 null */
export function contextWindowFromTable(model: string): number | null {
  if (!model) return null
  for (const [re, win] of MODEL_CONTEXT_WINDOWS) {
    if (re.test(model)) return win
  }
  return null
}

/**
 * 最终窗口大小：DB 用户配置优先，其次内置映射，最后默认。
 *
 * `dbValue` 由调用方查好传进来（保持本函数纯、可单测）；非正数/NaN 视为"没配"，
 * 不能当成 0 而让阈值变成 0（那会每轮都压缩）。
 */
export function resolveContextWindow(model: string, dbValue?: number | null): number {
  const fromDb = Number(dbValue)
  if (Number.isFinite(fromDb) && fromDb > 0) return Math.round(fromDb)
  return contextWindowFromTable(model) ?? DEFAULT_CONTEXT_WINDOW
}
