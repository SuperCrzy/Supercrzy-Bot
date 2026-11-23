import { watch, type Ref } from 'vue'

/** Keep unsent composer content separate while switching between open chats. */
export function useSessionDrafts<T>(sessionId: () => string | null, text: Ref<string>, attachments: Ref<T[]>) {
  const drafts = new Map<string | null, { text: string; attachments: T[] }>()
  watch(sessionId, (next, previous) => {
    if (text.value || attachments.value.length) drafts.set(previous, { text: text.value, attachments: [...attachments.value] })
    else drafts.delete(previous)
    const draft = drafts.get(next)
    text.value = draft?.text ?? ''
    attachments.value = draft ? [...draft.attachments] : []
  }, { flush: 'sync' })
  function addAttachments(target: string | null, files: T[]) {
    if (sessionId() === target) attachments.value.push(...files)
    else {
      const draft = drafts.get(target) ?? { text: '', attachments: [] }
      draft.attachments.push(...files)
      drafts.set(target, draft)
    }
  }
  return { addAttachments }
}
