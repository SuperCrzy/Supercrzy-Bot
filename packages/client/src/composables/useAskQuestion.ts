/**
 * Agent 结构化提问（`ask_question` 工具）—— 从 ChatView.vue 抽出
 *
 * 流程：后端在 agent 流里下发 `question` 事件 → 前端把 `msg.pendingQuestion` 填上 →
 * 顶部浮层（QuestionFloating）渲染 → 用户选一项或点跳过 → 本模块 POST
 * `/api/chat/question-answer` 并清掉 `msg.pendingQuestion`。
 *
 * 三个必须保留的语义：
 *   1. **空答复 = 跳过**（不是"忽略"）：后端据此让 AI 自行决策，所以 `skipQuestion`
 *      要真的发 `answer: ''`，不能只关面板——否则任务会永远卡在等回答。
 *   2. **定位靠 `pendingQuestion.id` 而不是消息下标**：流式期间消息会增删，
 *      下标不可靠；找不到消息时**直接 return**（不要用一个兜底消息乱答）。
 *   3. **HTTP 失败不阻塞 UI**：`catch` 里仍要清 `pendingQuestion`，
 *      否则用户被一个再也答不上的浮层永久挡住。
 */
import type { ChatMessage } from '@/types'

export interface FloatingQuestion {
  id: string
  question: string
  options: string[]
}

export interface UseAskQuestionOptions {
  /** 当前消息列表（getter：声明位置在本模块调用点之后） */
  messages: () => ChatMessage[]
}

export function useAskQuestion(opts: UseAskQuestionOptions) {
  const { messages } = opts

  /** 答复提问：提交给后端 resolveQuestion，清除面板 */
  async function answerQuestion(msg: ChatMessage, answer: string) {
    if (!msg.pendingQuestion || !answer.trim()) return
    const qid = msg.pendingQuestion.id
    try {
      await fetch('/api/chat/question-answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: qid, answer: answer.trim() }),
      })
    } catch { /* 失败不阻塞 UI */ }
    msg.pendingQuestion = undefined
  }

  /** 浮层答复：定位消息后复用 answerQuestion（对齐 WorkBuddy QuestionFloating onSelect） */
  async function answerQuestionFromFloating(q: FloatingQuestion, answer: string) {
    const msg = messages().find((m) => m.pendingQuestion?.id === q.id)
    if (!msg) return
    await answerQuestion(msg, answer)
  }

  /** 浮层跳过：发空答复让 AI 自己决定（对齐 WorkBuddy onSkip） */
  async function skipQuestion(q: FloatingQuestion) {
    const msg = messages().find((m) => m.pendingQuestion?.id === q.id)
    if (!msg) return
    try {
      await fetch('/api/chat/question-answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: q.id, answer: '' }),
      })
    } catch { /* 失败不阻塞 UI */ }
    msg.pendingQuestion = undefined
  }

  return { answerQuestion, answerQuestionFromFloating, skipQuestion }
}
