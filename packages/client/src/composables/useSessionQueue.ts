import { ref, watch } from 'vue'

export interface PendingQueueItem { id: string; text: string }

export function shouldAutoSendQueue(origin: string | undefined, active: string | null, count: number, completed = true): boolean {
  return completed && !!origin && origin === active && count > 0
}

/** Unsent queued messages belong to the conversation where they were added. */
export function useSessionQueue(sessionId: () => string | null) {
  const queues = new Map<string, PendingQueueItem[]>()
  const active = ref<PendingQueueItem[]>([])
  watch(sessionId, (next, previous) => {
    if (previous) {
      if (active.value.length) queues.set(previous, [...active.value])
      else queues.delete(previous)
    }
    active.value = next ? [...(queues.get(next) || [])] : []
  }, { flush: 'sync' })
  return active
}
