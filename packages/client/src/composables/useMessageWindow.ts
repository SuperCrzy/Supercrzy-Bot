/**
 * 消息区滚动跟随 + 消息级渐进渲染（主流实现 react-virtuoso 同款思路：只渲染视口附近，长会话不卡）。
 *
 * 抽自 `ChatView.vue`（I10 低风险批）。两块逻辑本来就是一件事（`onScroll` 同时驱动两者），
 * 拆开会需要互相回指，所以按"消息区视口"整体下沉。
 *
 * 传给这里的 `messages` 用 getter（组件里它的声明位置在本块之后，直接传 ref 会撞 TDZ）。
 *
 * 三个"改了就会退化"的点：
 *   · `scrollToBottom` 流式期间必须尊重 `stickToBottom` —— 原实现 `isLoading` 期间无条件滚，
 *     用户上滑被强行拉回，界面划不上去
 *   · `loadEarlier` 前移窗口后要用 rAF 补回 `scrollTop` 差值，否则内容插在顶部会让视口跳动
 *   · `nextIsAssistant` 按 **id** 定位而不是索引 —— 窗口切片后 msgIdx 不再映射全局 index，用索引会让工具条错位
 */
import { computed, ref, type Ref } from 'vue'
import type { ChatMessage } from '@/types'

export interface UseMessageWindowOptions {
  /** 当前会话全量消息（getter：避免与组件的声明顺序绑死） */
  messages: () => ChatMessage[]
  /** 消息区容器（`ref="messagesRef"` 绑定的那个） */
  messagesRef: Ref<HTMLElement | undefined>
  /** 单批渲染条数，默认 40 */
  chunk?: number
  /** 贴底容差（px），默认 20 */
  bottomTolerance?: number
  /** 接近顶部多少 px 触发加载更早一批，默认 600 */
  loadTriggerPx?: number
}

export function useMessageWindow(opts: UseMessageWindowOptions) {
  const CHUNK = opts.chunk ?? 40
  const BOTTOM_TOL = opts.bottomTolerance ?? 20
  const LOAD_TRIGGER = opts.loadTriggerPx ?? 600

  /** 窗口起点（0 = 从最早消息开始；尾部优先 → 初始 = len - CHUNK） */
  const renderStart = ref(0)
  /** 窗口内可见消息（尾部优先 slice） */
  const visibleMessages = computed(() => opts.messages().slice(renderStart.value))
  /** 加载更早防重入 */
  let loadingMore = false

  /** 是否吸附底部（用户手动上滚时暂停自动滚动，回到底部恢复） */
  const stickToBottom = ref(true)
  /** 内容是否可滚动（超出容器才显示回底按钮；不溢出时按钮隐藏） */
  const canScroll = ref(false)
  /** 当前滚动位置对应的提问序号（历史提问导航条高亮用） */
  const activeQuestionIndex = ref(0)

  /** 相邻 AI 消息判断：窗口切片后 msgIdx 不再映射全局 index → 按 id 定位，防止工具条错位 */
  function nextIsAssistant(msg: ChatMessage): boolean {
    const list = opts.messages()
    const i = list.findIndex((m) => m.id === msg.id)
    return i >= 0 && list[i + 1]?.role === 'assistant'
  }

  function updateCanScroll() {
    const el = opts.messagesRef.value
    if (!el) return
    canScroll.value = el.scrollHeight > el.clientHeight + BOTTOM_TOL
  }

  /** 滚动时更新：找视口内最靠近顶部的那条 user 消息，返回它的提问序号 */
  function updateActiveQuestion() {
    const el = opts.messagesRef.value
    if (!el) return
    const wrappers = el.querySelectorAll('.message-wrapper[data-msg-id]')
    let bestId = ''
    let bestDist = Infinity
    wrappers.forEach((w) => {
      const top = (w as HTMLElement).offsetTop
      const dist = Math.abs(top - el.scrollTop)
      if (dist < bestDist) {
        bestDist = dist
        bestId = (w as HTMLElement).dataset.msgId || ''
      }
    })
    if (!bestId) return
    // 统计该消息之前有多少条 user 消息（含自己）= 提问序号
    let qIdx = 0
    for (const m of opts.messages()) {
      if (m.id === bestId) break
      if (m.role === 'user') qIdx++
    }
    activeQuestionIndex.value = qIdx
  }

  /** 向上加载更早一批：renderStart 前移 + 滚动位置补偿（新增内容在顶部，scrollTop 需 + 高度差） */
  function loadEarlier() {
    if (renderStart.value <= 0 || loadingMore) return
    const el = opts.messagesRef.value
    const prevH = el?.scrollHeight || 0
    loadingMore = true
    renderStart.value = Math.max(0, renderStart.value - CHUNK)
    requestAnimationFrame(() => {
      if (el) el.scrollTop += el.scrollHeight - prevH
      loadingMore = false
    })
  }

  /** 流式完成（done）后：窗口保持尾部（若用户停留在底部）；加载更早的窗口不被打扰 */
  function resetRenderWindow() {
    renderStart.value = Math.max(0, opts.messages().length - CHUNK)
  }

  function scrollToBottom(force = false) {
    // 流式期间遵循用户滚动位置：stickToBottom 为 false（用户上滑查看历史）时不强制拉回，
    // 用户回到底部自动恢复跟随；force 仅用于切换会话/新消息等明确场景。
    if (!force && !stickToBottom.value) return
    // rAF 双保险：DOM 高度（v-html/打字机）稳定后再滚，避免滚动位置被内容变化顶回
    requestAnimationFrame(() => {
      const el = opts.messagesRef.value
      if (!el) return
      el.scrollTop = el.scrollHeight
      updateCanScroll()
    })
  }

  function onScroll() {
    const el = opts.messagesRef.value
    if (!el) return
    // 流式中也尊重用户滚动位置（主流实现 useMessageScroll 同款：用户上滑 → 暂停自动跟随）：
    // 内容增长不触发 scroll 事件，但用户主动滚动会触发 → stickToBottom 状态可靠
    stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_TOL
    // 渐进渲染：接近顶部 → 加载更早一批消息（滚动位置补偿，防跳动）
    if (el.scrollTop < LOAD_TRIGGER && renderStart.value > 0) loadEarlier()
    updateActiveQuestion()
    updateCanScroll()
  }

  return {
    renderStart, visibleMessages, stickToBottom, canScroll, activeQuestionIndex,
    nextIsAssistant, updateCanScroll, updateActiveQuestion,
    loadEarlier, resetRenderWindow, scrollToBottom, onScroll,
  }
}
