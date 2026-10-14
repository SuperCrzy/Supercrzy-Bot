/**
 * 输入框高度记忆（对齐 WorkBuddy ChatInput：拖拽调高 + localStorage 记忆，刷新保持）。
 *
 * 抽自 `ChatView.vue`（I10 低风险批）。0 = 自动（autosize），>0 = 固定像素高。
 *
 * 两个刻意的行为：
 *   · 只接受 `[MIN, MAX]` 区间内的记忆值 —— localStorage 可能是旧版本/手改的脏值，
 *     越界值直接放弃，否则输入框会撑满整屏或压成一条线
 *   · 启动时读、拖拽结束才写 —— 拖拽过程中每帧写 localStorage 会明显掉帧
 */
import { onUnmounted, ref } from 'vue'

export const INPUT_HEIGHT_KEY = 'supercrzy:inputHeight'
export const INPUT_HEIGHT_MIN = 60
export const INPUT_HEIGHT_MAX = 260

export function useInputHeight() {
  const inputHeight = ref(0) // 0 = 自动（autosize）
  try {
    const saved = Number(localStorage.getItem(INPUT_HEIGHT_KEY))
    if (saved >= INPUT_HEIGHT_MIN && saved <= INPUT_HEIGHT_MAX) inputHeight.value = saved
  } catch { /* 隐私模式读不了 localStorage：用自动高度兜底，别让启动挂掉 */ }

  let resizeState: { startY: number; startH: number } | null = null

  /** 拖拽开始（手柄 mousedown） */
  function startHeightResize(e: MouseEvent) {
    e.preventDefault()
    resizeState = { startY: e.clientY, startH: inputHeight.value > 0 ? inputHeight.value : 90 }
    document.addEventListener('mousemove', onHeightDrag)
    document.addEventListener('mouseup', stopHeightResize)
  }

  function onHeightDrag(e: MouseEvent) {
    if (!resizeState) return
    inputHeight.value = Math.min(
      INPUT_HEIGHT_MAX,
      Math.max(INPUT_HEIGHT_MIN, resizeState.startH + (e.clientY - resizeState.startY)),
    )
  }

  function stopHeightResize() {
    document.removeEventListener('mousemove', onHeightDrag)
    document.removeEventListener('mouseup', stopHeightResize)
    resizeState = null
    if (inputHeight.value > 0) {
      try {
        localStorage.setItem(INPUT_HEIGHT_KEY, String(inputHeight.value))
      } catch { /* 写不了就算了，本次会话内仍然生效 */ }
    }
  }

  // 组件卸载时必须解绑全局监听：拖拽中途切路由会留下两条 document 监听，泄漏且互相打架
  onUnmounted(stopHeightResize)

  return { inputHeight, startHeightResize, stopHeightResize }
}
