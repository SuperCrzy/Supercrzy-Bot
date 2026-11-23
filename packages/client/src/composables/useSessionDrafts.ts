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
  function updateAttachment(target: string | null, predicate: (file: T) => boolean, update: (file: T) => void) {
    const list = sessionId() === target ? attachments.value : drafts.get(target)?.attachments
    const file = list?.find(predicate)
    if (file) update(file)
  }
  function consumeDraft(target: string | null, sentText: string, sentFiles: T[]) {
    const current = sessionId() === target
    const draft = current ? { text: text.value, attachments: attachments.value } : drafts.get(target)
    if (!draft) return
    const nextText = draft.text.trim() === sentText ? '' : draft.text
    const nextAttachments = draft.attachments.filter(file => !sentFiles.includes(file))
    if (current) {
      text.value = nextText
      attachments.value = nextAttachments
    } else if (nextText || nextAttachments.length) drafts.set(target, { text: nextText, attachments: nextAttachments })
    else drafts.delete(target)
  }
  return { addAttachments, updateAttachment, consumeDraft }
}
