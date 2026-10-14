/**
 * 自动朗读（回复完成 → 自动读出来）的判定逻辑。纯函数，无浏览器 API，便于单测。
 *
 * 为什么单独成文件：这个功能唯一会「烦到人」的风险全在这几个判定上 ——
 *   ① 任务**失败/中断**时出声（念的还是半截或错误内容，比不念更糟）
 *   ② 老板正盯着屏幕看时突然出声（他已经在「读」了，出声是干扰）
 *   ③ 空回复 / 只有代码块的回复出声（无可读文本）
 * 所以判定写成不变量逐格测，而不是埋在组件里靠手感。
 *
 * 三档（2026-09-27 老板拍板，默认 background）：
 *   off        只手动点朗读按钮
 *   background 仅当窗口不在前台时自动朗读（覆盖"发完长任务去干活，回来听结果"）
 *   always     回复完成即朗读
 */

export type AutoReadMode = 'off' | 'background' | 'always'

export const AUTO_READ_MODES: readonly AutoReadMode[] = ['off', 'background', 'always'] as const

/** 默认档位：仅窗口不在前台时自动朗读（老板 2026-09-27 拍板） */
export const DEFAULT_AUTO_READ_MODE: AutoReadMode = 'background'

/** 归一化设置值：认不出的一律落回默认档（老库无此键 → undefined → 默认档） */
export function normalizeAutoReadMode(v: unknown): AutoReadMode {
  const s = String(v ?? '').trim()
  return (AUTO_READ_MODES as readonly string[]).includes(s) ? (s as AutoReadMode) : DEFAULT_AUTO_READ_MODE
}

export interface ShouldAutoReadInput {
  /** 设置里的档位（未归一化也接受） */
  mode: unknown
  /** 本轮是否**成功**结束（失败/中断/用户手动停止 → false） */
  ok: boolean
  /** 本轮最终答案是否有可朗读文本（清洗代码块/表格/图/URL 之后仍非空） */
  hasText: boolean
  /** 窗口当前是否在前台（可见且聚焦） */
  foreground: boolean
}

/**
 * 本轮结束后是否应当自动朗读。
 *
 * 判定顺序有意如此：**先看能不能读，再看要不要读**。
 * 失败/无文本时无论档位都直接否决 —— 读一段失败任务的半截内容是负价值。
 */
export function shouldAutoRead(input: ShouldAutoReadInput): boolean {
  if (!input.ok) return false
  if (!input.hasText) return false
  const mode = normalizeAutoReadMode(input.mode)
  if (mode === 'off') return false
  if (mode === 'always') return true
  // background：只在不看屏幕时读
  return !input.foreground
}

/**
 * 窗口是否在前台（可见 + 聚焦）。
 *
 * ⚠️ 两个条件都要：
 *  - 浏览器/PWA 里切标签页 → `visibilityState === 'hidden'`
 *  - **Electron 里最小化窗口时 `visibilityState` 不一定更新**（Chromium 在 BrowserWindow
 *    最小化时可能仍报 visible），但 `document.hasFocus()` 会变 false ⇒ 必须两个一起看，
 *    否则"桌面端最小化后不朗读"这个最主要场景反而失效。
 *
 * 取不到 API 时保守返回 true（视为前台 = 不自动读）—— 宁可少读，不可突然出声。
 */
export function isWindowForeground(): boolean {
  if (typeof document === 'undefined') return true
  const state = (document as any).visibilityState
  const visible = typeof state === 'string' ? state !== 'hidden' : true
  let focused = true
  if (typeof (document as any).hasFocus === 'function') {
    try {
      focused = document.hasFocus()
    } catch {
      focused = true // 取不到就当前台：这条路径在"本轮结束"热路径上，绝不能被它打断
    }
  }
  return visible && focused
}
