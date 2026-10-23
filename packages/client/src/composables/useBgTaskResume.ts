/**
 * Background-task resume orchestration (chat side).
 *
 * Extracted from ChatView because that file sits at its size gate: the logic here is pure
 * orchestration (guard → create assistant message → call the send path), with every dependency
 * injected so this file has no knowledge of the view's refs.
 *
 * Constraints encoded here (they are product rules, not implementation details):
 *   1. Never interrupt a turn that is already running — the task result stays on the dock and the
 *      user decides. Interrupting would hijack whatever they are currently asking.
 *   2. No fake user bubble: the task result is injected server-side as a system-shaped user
 *      message (`bgResume`), so the transcript shows only the assistant's follow-up.
 *   3. Only the tail (2000 chars, truncated server-side) is sent — a chatty build must not blow up
 *      the context window.
 */
import type { ChatMessage } from '@/types'

export interface BgTaskDonePayload {
  id: string
  title?: string
  exitCode?: number | null
  tail?: string
}

export interface UseBgTaskResumeOptions {
  isLoading: () => boolean
  currentSessionId: () => string | null
  /** Send one turn. Implemented by the view (it owns the SSE reader and the abort controller). */
  send: (
    assistantMsg: ChatMessage,
    apiMessages: Array<{ role: string; content: string }>,
    bgResume: { taskId: string; title?: string; exitCode?: number | null; tail?: string },
  ) => Promise<void>
  addMessage: (sessionId: string, msg: ChatMessage) => void
  setLoading: (v: boolean) => void
  setAbort: (c: AbortController | null) => void
  newAbort: () => AbortController
}

export function useBgTaskResume(opts: UseBgTaskResumeOptions) {
  async function onBgTaskDone(task: BgTaskDonePayload) {
    if (!task?.id) return
    if (opts.isLoading()) return
    const sid = opts.currentSessionId()
    if (!sid) return

    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      flow: [],
    }
    opts.addMessage(sid, assistantMsg)
    opts.setLoading(true)
    opts.setAbort(opts.newAbort())
    try {
      await opts.send(assistantMsg, [], {
        taskId: task.id,
        title: task.title,
        exitCode: task.exitCode ?? null,
        tail: task.tail,
      })
    } catch {
      // 续跑失败不改写正文（会把本轮答案顶掉）：留空，任务结果仍在浮条上
    } finally {
      opts.setLoading(false)
      opts.setAbort(null)
    }
  }

  return { onBgTaskDone }
}
