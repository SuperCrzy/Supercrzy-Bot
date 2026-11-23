import { watch, type Ref } from 'vue'

/** Keep unsent composer content separate while switching between open chats. */
export function useSessionDrafts<T>(sessionId: () => string | null, text: Ref<string>, attachments: Ref<T[]>): void {
  const drafts = new Map<string, { text: string; attachments: T[] }>()
  watch(sessionId, (next, previous) => {
    if (previous) {
      if (text.value || attachments.value.length) drafts.set(previous, { text: text.value, attachments: [...attachments.value] })
      else drafts.delete(previous)
    }
    const draft = next ? drafts.get(next) : undefined
    text.value = draft?.text ?? ''
    attachments.value = draft ? [...draft.attachments] : []
  }, { flush: 'sync' })
}
