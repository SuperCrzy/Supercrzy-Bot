import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ChatSession, ChatMessage, ContentBlock, TextBlock } from '@/types'

/** 将旧格式字符串 content 转为 ContentBlock[] */
function normalizeContent(content: any): ContentBlock[] {
  if (Array.isArray(content)) return content as ContentBlock[]
  if (typeof content === 'string') {
    // 尝试解析 JSON 数组（Agent 存储的消息格式）
    if (content.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(content)
        if (Array.isArray(parsed)) return parsed as ContentBlock[]
      } catch { /* fall through */ }
    }
    return content ? [{ type: 'text', text: content }] : []
  }
  return []
}

/** 人性化时间显示 — 兼容多种日期格式 */
export function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return ''
  // 兼容 SQLite 格式 "2026-05-07 06:44:42"
  const normalized = dateStr.includes(' ') && !dateStr.includes('T')
    ? dateStr.replace(' ', 'T') + 'Z'
    : dateStr
  const date = new Date(normalized).getTime()
  if (isNaN(date)) return dateStr.slice(0, 10)
  const now = Date.now()
  const diff = now - date
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}天前`
  if (days < 30) return `${Math.floor(days / 7)}周前`
  if (days < 365) return `${Math.floor(days / 30)}个月前`
  return `${Math.floor(days / 365)}年前`
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<ChatSession[]>([])
  const currentSessionId = ref<string | null>(null)
  const messages = ref<Map<string, ChatMessage[]>>(new Map())
  const isLoading = ref(false)
  const loaded = ref(false)
  /** 分支续跑信号：TimelinePanel 设置后，ChatView 监听并发起续跑 */
  const pendingResume = ref<string | null>(null)

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
        const data: any[] = await res.json()
        // 规范化字段名：后端返回 created_at → 前端用 createdAt
        sessions.value = data.map((s: any) => ({
          id: s.id,
          title: s.title || '新对话',
          createdAt: s.created_at || s.createdAt,
          updatedAt: s.updated_at || s.updatedAt,
          model: s.model || 'deepseek-v4-pro',
        }))
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
          // 兼容旧数据：将字符串 content 转为 ContentBlock[]
          const normalized = data.messages.map((m: any) => ({
            ...m,
            content: normalizeContent(m.content),
          }))
          messages.value.set(sessionId, normalized)
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

    // 首次用户消息 → 自动命名会话
    if (message.role === 'user') {
      const userMsgs = list.filter((m) => m.role === 'user')
      if (userMsgs.length === 1) {
        const firstBlock = Array.isArray(message.content) ? message.content[0] : undefined
        const text = firstBlock && firstBlock.type === 'text' ? firstBlock.text : ''
        const title = text.slice(0, 40) || '新对话'
        const session = sessions.value.find((s) => s.id === sessionId)
        if (session && session.title === '新对话') {
          session.title = title
          // 持久化标题
          try {
            await fetch(`/api/sessions/${sessionId}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title }),
            })
          } catch {}
        }
      }
    }

    // 持久化到后端
    try {
      const contentStr = JSON.stringify(message.content)
      await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: message.id,
          role: message.role,
          content: contentStr,
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
      last.content = normalizeContent(content)
    }
  }

  // ---- 持久化最后一条消息的最终内容（流式完成后调用） ----
  async function persistLastMessage(sessionId: string) {
    const list = messages.value.get(sessionId)
    if (!list || list.length === 0) return
    const last = list[list.length - 1]
    try {
      const contentStr = JSON.stringify(last.content)
      await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: last.id,
          role: last.role,
          content: contentStr,
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
    pendingResume,
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
