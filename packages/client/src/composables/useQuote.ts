/**
 * 对话内一键引用（对齐飞书"引用回复" + harness reference insert）。
 *
 * 抽自 `ChatView.vue`（I10 低风险批）。两条入口：
 *   · 整条引用 —— 消息 hover 的引用按钮
 *   · 选中片段引用 —— 消息区 mouseup 检测选区 → 浮动按钮
 *
 * 依赖只三样（`messages` / `inputRef` / `t`），都由调用方传入：
 * 这里不碰 store、不碰 i18n 单例，因此可以脱离组件单测。
 */
import { nextTick, ref, type Ref } from 'vue'
import type { ChatMessage } from '@/types'
import { messagePlainText } from '@/utils/message-text'

export interface QuoteRef { msgId: string; role: string; excerpt: string }

export interface UseQuoteOptions {
  /**
   * 当前会话消息（选区引用要按 id 反查消息）。
   * 用 **getter** 而不是 `Ref`：组件里 `messages` 的声明位置在引用块之后，
   * 直接把 ref 传进来会在 setup 阶段读到一个尚未初始化的 `const`（TDZ）。
   */
  messages: () => ChatMessage[]
  /** NaiveUI 输入框实例（引用完成后要把焦点送回输入框） */
  inputRef: Ref<any>
  t: (key: string) => string
  /** 选中片段长度上限（超过就不弹引用按钮，避免整篇被引） */
  selectionLimit?: number
}

export function useQuote(opts: UseQuoteOptions) {
  const limit = opts.selectionLimit ?? 500
  const quoteRef = ref<QuoteRef | null>(null)
  /** 选区引用浮动按钮的归属消息 id */
  const selQuoteMsgId = ref('')
  const selQuoteVisible = ref(false)
  const selQuotePos = ref({ x: 0, y: 0 })

  function focusInput() {
    nextTick(() => {
      const ta = opts.inputRef.value?.textareaElRef ?? opts.inputRef.value?.$el?.querySelector?.('textarea')
      ta?.focus()
    })
  }

  /**
   * 整条消息引用（取正文前 200 字）。
   * 2026-08-25 修复：原 `extractText(msg.content)` 在 content 为 string（markdown）时抛
   * "filter is not a function" → 点击无反应；改用 messagePlainText 兼容 string / ContentBlock[] 两种形态。
   */
  function quoteMessage(msg: ChatMessage) {
    const text = messagePlainText(msg).trim()
      || (msg.flow || []).filter((n) => n.kind === 'text').map((n: any) => n.text).join('\n').trim()
    if (!text) return
    quoteRef.value = { msgId: msg.id, role: msg.role, excerpt: text.slice(0, 200) }
    focusInput()
  }

  /** 消息区 mouseup：检测选区 → 决定浮动按钮是否出现与落点 */
  function handleQuoteMouseUp() {
    // 延迟检测：mouseup 后选区才稳定（10ms 是实测够用的最小值，别再往下调）
    setTimeout(() => {
      const sel = window.getSelection()
      const text = sel ? sel.toString().trim() : ''
      const wrapper = sel && sel.anchorNode
        ? (sel.anchorNode as HTMLElement).closest?.('.message-wrapper')
        : null
      if (text && text.length <= limit && wrapper && wrapper.querySelector('.message')) {
        selQuoteMsgId.value = wrapper.getAttribute('data-msg-id') || ''
        try {
          const rect = sel!.getRangeAt(0).getBoundingClientRect()
          // x 夹到窗口右侧 140px 内（按钮宽度），y 至少留 8px —— 否则贴边时按钮会跑出视口/被顶栏盖住
          selQuotePos.value = { x: Math.min(rect.left, window.innerWidth - 140), y: Math.max(8, rect.bottom + 6) }
        } catch { /* 跨节点选区取 rect 会抛，忽略即可（按钮按默认位置出现） */ }
        selQuoteVisible.value = true
      } else {
        selQuoteVisible.value = false
      }
    }, 10)
  }

  /** 确认引用选中片段 */
  function quoteSelection() {
    const sel = window.getSelection()
    const text = sel ? sel.toString().trim() : ''
    if (!text) return
    const msg = opts.messages().find((m) => m.id === selQuoteMsgId.value)
    if (!msg) return
    quoteRef.value = { msgId: msg.id, role: msg.role, excerpt: text.slice(0, limit) }
    selQuoteVisible.value = false
    sel?.removeAllRanges()
    focusInput()
  }

  /** 发送时把引用拼进用户消息文本（后端据此注入 AI 上下文） */
  function injectQuote(text: string): string {
    if (!quoteRef.value) return text
    const q = quoteRef.value
    const role = q.role === 'user' ? opts.t('chat.quoteOfUser') : opts.t('chat.quoteOfAssistant')
    return `${text.trim() ? text.trim() + '\n\n' : ''}> ${role}：${q.excerpt}`
  }

  /** 清空引用（发送完成 / 切换会话） */
  function clearQuote() {
    quoteRef.value = null
    selQuoteVisible.value = false
  }

  return { quoteRef, selQuoteMsgId, selQuoteVisible, selQuotePos, quoteMessage, handleQuoteMouseUp, quoteSelection, focusInput, injectQuote, clearQuote }
}
