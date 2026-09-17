/**
 * 输入框触发词解析（P1-04 从 ChatView.vue 下沉，2026-09-17）
 *
 * 原先 `detectTrigger` 把"解析"和"改一堆 ref"混在一起，导致这段唯一有点复杂度的
 * 字符串处理完全没有测试覆盖。此处只保留**纯解析**：给定文本与光标位置，
 * 返回当前是否处于 `/` 或 `@` 触发态及其查询词。
 *
 * 规则（与迁移前逐字一致）：
 *   - 触发符必须位于行首或空白之后（`(?:^|\s)`），避免把 URL / 邮箱里的 @ 当触发；
 *   - 查询词不能含空白或另一个触发符（`[^\s\/@]*`）；
 *   - 只取光标之前的内容（光标后的字符不参与判断）。
 */

export interface TriggerMatch {
  char: '/' | '@'
  query: string
}

/** 解析触发态；不在触发态返回 null */
export function parseTrigger(text: string, caretPos: number): TriggerMatch | null {
  const safeText = typeof text === 'string' ? text : ''
  const pos = Math.max(0, Math.min(Number(caretPos) || 0, safeText.length))
  const before = safeText.slice(0, pos)
  const m = before.match(/(?:^|\s)([/@])([^\s/@]*)$/)
  if (!m) return null
  return { char: m[1] as '/' | '@', query: m[2] }
}
