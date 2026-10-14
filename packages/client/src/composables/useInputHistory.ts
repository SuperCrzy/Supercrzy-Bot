/**
 * 输入历史（对齐 WorkBuddy use-input-history）：↑ 找回上一条，↓ 回下一条，终端习惯。
 *
 * 抽自 `ChatView.vue`（I10 低风险批）。三处依赖由调用方以参数传入 —— 组件不再持有状态，
 * 这里因此可以纯单测（不依赖 DOM、不依赖 store）。
 *
 * 行为细节（都是刻意的，别顺手"优化"掉）：
 *   · 输入框**已有内容**且**不在浏览历史**时，↑↓ 必须放行给光标/预览，不能劫持
 *   · 触发菜单（`/` 或 `@`）激活时 ↑↓ 归候选导航所有 —— 这条靠 `isTriggerActive` 注入
 *   · 每次落到历史项后要把光标推到末尾，否则 NaiveUI textarea 会停在旧位置，接着打字会插到中间
 */
import { nextTick, ref, type Ref } from 'vue'

export interface UseInputHistoryOptions {
  /** 收发共用的输入文本 */
  inputText: Ref<string>
  /**
   * NaiveUI Input 实例（取原生 textarea 才能 setSelectionRange）。
   * 用 **getter** 而不是 `Ref`：组件里 `inputRef` 的声明位置在本块之后，
   * 直接传变量会在 `setup()` 阶段读到尚未初始化的 `const`（TDZ 报错）。
   */
  inputRef: () => any
  /** 触发菜单激活中 → 不接管 ↑↓ */
  isTriggerActive?: () => boolean
  /** 历史上限，默认 50 */
  max?: number
}

export function useInputHistory(opts: UseInputHistoryOptions) {
  const max = opts.max ?? 50
  const inputHistory = ref<string[]>([])
  /** -1 = 不在浏览历史 */
  const historyIdx = ref(-1)

  /** 聚焦并把光标推到末尾（NaiveUI 两层结构都要试：新版本暴露 textareaElRef，老版本只能翻 $el） */
  function focusTail() {
    nextTick(() => {
      const el = opts.inputRef() as any
      const ta = el?.textareaElRef ?? el?.$el?.querySelector?.('textarea')
      if (ta) {
        ta.focus()
        ta.setSelectionRange(ta.value.length, ta.value.length)
      } else {
        el?.focus?.()
      }
    })
  }

  /** 发送成功时记录进历史（去重：与最新一条相同则不重复记） */
  function pushInputHistory(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    if (inputHistory.value[0] === trimmed) return
    inputHistory.value.unshift(trimmed)
    if (inputHistory.value.length > max) inputHistory.value.pop()
    historyIdx.value = -1
  }

  /** ↑：找回上一条（输入为空或已在浏览历史时接管；有内容且未浏览 → 放行光标） */
  function historyPrev(e?: KeyboardEvent) {
    if (opts.isTriggerActive?.()) return
    if (opts.inputText.value && historyIdx.value < 0) return
    e?.preventDefault()
    if (inputHistory.value.length === 0) return
    historyIdx.value = historyIdx.value < 0 ? 0 : Math.min(historyIdx.value + 1, inputHistory.value.length - 1)
    opts.inputText.value = inputHistory.value[historyIdx.value]
    focusTail()
  }

  /** ↓：回下一条（越过最旧一条 → 清空） */
  function historyNext(e?: KeyboardEvent) {
    if (opts.isTriggerActive?.()) return
    if (opts.inputText.value && historyIdx.value < 0) return
    e?.preventDefault()
    if (historyIdx.value <= 0) {
      historyIdx.value = -1
      opts.inputText.value = ''
      return
    }
    historyIdx.value--
    opts.inputText.value = inputHistory.value[historyIdx.value]
    focusTail()
  }

  /** 退出浏览态（发送后 / 切换会话时调用，避免 ↑ 回到别的会话的输入） */
  function resetHistoryCursor() { historyIdx.value = -1 }

  return { inputHistory, historyIdx, pushInputHistory, historyPrev, historyNext, resetHistoryCursor }
}
