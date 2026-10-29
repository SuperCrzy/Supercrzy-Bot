import { onMounted, onUnmounted, ref, watch } from 'vue'

/**
 * Maximise state for the right detail panel (`92%` overlay over the chat area).
 *
 * Kept out of `DetailPanel.vue` on purpose: the component sits on a size gate, and
 * this state needs three independent exits (see below) plus window-level listeners.
 *
 * Why the exits exist: the maximise button lives **inside** the preview / AI-browser
 * tab content. A user who maximises and then switches to another tab (artifacts,
 * files, timeline) has no toggle left on screen — the panel then covers the chat with
 * no way back. So:
 *   1. `restore()` for the "restore" button in the panel's own tab strip;
 *   2. `Escape`;
 *   3. auto-restore when the active tab changes or the panel closes.
 *
 * @param isVisible current panel visibility (`detailPanelVisible`)
 * @param activeTab current tab key; any change drops back to the normal width
 * @param sessionId current conversation id; a sidebar click on another
 *   conversation must also hand the chat area back — the maximised overlay
 *   belongs to one session, and browsing conversations must never leave the
 *   chat trapped under it
 */
export function usePanelMaximize(
  isVisible: () => boolean,
  activeTab: () => string,
  sessionId: () => string | null | undefined = () => undefined,
) {
  const maximized = ref(false)
  const restore = () => {
    maximized.value = false
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !maximized.value) return
    // Dialogs own their own Escape; so do text fields (caret, IME candidate windows).
    if (e.defaultPrevented || document.querySelector('.n-modal')) return
    const el = e.target as HTMLElement | null
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
    restore()
  }

  /**
   * Touching the sidebar always hands the chat area back.
   *
   * The maximised panel starts at the sidebar's right edge, so its conversations
   * stay visible — but without this, clicking one only closes the overlay when it
   * happens to be a *different* conversation. Clicking the same one, the logo or
   * empty space left the chat covered with no feedback.
   */
  function onPointerDown(e: PointerEvent) {
    if (!maximized.value) return
    const el = e.target as HTMLElement | null
    if (el && el.closest('.sidebar, .sidebar-sash, .mobile-topbar')) restore()
  }

  onMounted(() => {
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('pointerdown', onPointerDown, true)
  })
  onUnmounted(() => {
    window.removeEventListener('keydown', onKeydown)
    window.removeEventListener('pointerdown', onPointerDown, true)
  })

  watch(isVisible, (v) => {
    if (!v) restore()
  })
  watch(activeTab, () => restore())
  watch(sessionId, () => restore())

  return { maximized, restore }
}
