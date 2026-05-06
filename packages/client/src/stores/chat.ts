import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ChatSession, ChatMessage } from '@/types'

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<ChatSession[]>([])
  const currentSessionId = ref<string | null>(null)
  const messages = ref<Map<string, ChatMessage[]>>(new Map())
  const isLoading = ref(false)
  const loaded = ref(false)

  const currentSession = computed(() =>
    sessions.value.find((s) => s.id === currentSessionId.value)
  )

  const currentMessages = computed(() =>
    currentSessionId.value ? (messages.value.get(currentSessionId.value) ?? []) : []
  )

  // ---- 从后端加载会话列表 ----
  async function loadSessions() {
    if (loaded.value) return
    try {
      const res = await fetch('/api/sessions')
      if (res.ok) {
        const data: ChatSession[] = await res.json()
        sessions.value = data
        // 如果没有当前会话，选第一个
        if (!currentSessionId.value && data.length > 0) {
          currentSessionId.value = data[0].id
        }
        loaded.value = true
      }
    } catch (err) {
      console.error('Failed to load sessions:', err)
    }
  }

  // ---- 加载指定会话的消息 ----
  async function loadMessages(sessionId: string) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`)
      if (res.ok) {
        const data = await res.json()
        if (data.messages) {
          messages.value.set(sessionId, data.messages)
        }
      }
    } catch (err) {
      console.error('Failed to load messages:', err)
    }
  }

  // ---- 创建新会话（持久化到后端） ----
  async function createSession(title?: string): Promise<ChatSession> {
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: title || '新对话',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: 'deepseek-v4-pro',
    }
    sessions.value.unshift(session)
    messages.value.set(session.id, [])
    currentSessionId.value = session.id

    // 持久化到后端
    try {
      await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: session.title, model: session.model, id: session.id }),
      })
    } catch (err) {
      console.error('Failed to persist session:', err)
    }
    return session
  }

  // ---- 选择会话并加载消息 ----
  async function selectSession(id: string) {
    currentSessionId.value = id
    // 如果消息未加载，从后端加载
    if (!messages.value.has(id) || messages.value.get(id)!.length === 0) {
      await loadMessages(id)
    }
  }

  // ---- 删除会话 ----
  async function deleteSession(id: string) {
    // 先删前端
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx !== -1) sessions.value.splice(idx, 1)
    messages.value.delete(id)
    if (currentSessionId.value === id) {
      currentSessionId.value = sessions.value[0]?.id ?? null
    }
    // 持久化删除
    try {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' })
    } catch (err) {
      console.error('Failed to delete session:', err)
    }
  }

  // ---- 添加消息（持久化到后端） ----
  async function addMessage(sessionId: string, message: ChatMessage) {
    const list = messages.value.get(sessionId) ?? []
    list.push(message)
    messages.value.set(sessionId, list)

    // 持久化到后端
    try {
      await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: message.id,
          role: message.role,
          content: message.content,
          token_count: message.tokenCount,
          cost: message.cost,
          attachments: message.attachments || undefined,
        }),
      })
    } catch (err) {
      console.error('Failed to persist message:', err)
    }
  }

  // ---- 更新最后一条消息内容（用于流式更新时本地暂存，不每次请求） ----
  function updateLastMessage(sessionId: string, content: string) {
    const list = messages.value.get(sessionId)
    if (list && list.length > 0) {
      const last = list[list.length - 1]
      last.content = content
    }
  }

  // ---- 持久化最后一条消息的最终内容（流式完成后调用） ----
  async function persistLastMessage(sessionId: string) {
    const list = messages.value.get(sessionId)
    if (!list || list.length === 0) return
    const last = list[list.length - 1]
    try {
      await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: last.id,
          role: last.role,
          content: last.content,
          token_count: last.tokenCount,
          cost: last.cost,
          attachments: last.attachments || undefined,
        }),
      })
    } catch (err) {
      console.error('Failed to persist last message:', err)
    }
  }

  function setLoading(v: boolean) {
    isLoading.value = v
  }

  return {
    sessions,
    currentSessionId,
    messages,
    isLoading,
    loaded,
    currentSession,
    currentMessages,
    loadSessions,
    loadMessages,
    createSession,
    selectSession,
    deleteSession,
    addMessage,
    updateLastMessage,
    persistLastMessage,
    setLoading,
  }
})
