/**
 * Keep the message list pinned to the bottom when the composer area changes height.
 *
 * Why this is its own unit: expanding the background-task list (or any future composer addon)
 * makes the footer taller and the message area shorter. The scroll container's `scrollTop` does not
 * change on its own, so the last reply gets clipped below the viewport — from the user's seat the
 * messages look stuck while the input area grows. Re-pinning visually pushes them up.
 *
 * Only re-pins when the user was already at the bottom (`stick()`), so reading history is never
 * yanked away mid-scroll.
 */
import { onBeforeUnmount, onMounted, type Ref } from 'vue'

export function useFooterResizeStick(
  target: Ref<HTMLElement | null>,
  stick: () => boolean,
  scrollToBottom: (force?: boolean) => void,
) {
  let ro: ResizeObserver | null = null

  onMounted(() => {
    const el = target.value
    if (!el || typeof ResizeObserver === 'undefined') return
    ro = new ResizeObserver(() => {
      if (stick()) scrollToBottom(true)
    })
    ro.observe(el)
  })

  onBeforeUnmount(() => {
    ro?.disconnect()
    ro = null
  })
}
