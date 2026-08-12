<template>
  <div class="chat-container">
    <!-- Top bar -->
    <header class="chat-header">
      <div class="chat-title-area">
        <h2 class="chat-title">{{ currentSession?.title || $t('chat.newChat') }}</h2>
        <n-tag size="small" :bordered="false" type="info" class="model-badge">
          {{ getModelShortName(appStore.currentModel) }}
        </n-tag>
      </div>
      <div class="header-actions">
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-button size="small" :type="agentMode ? 'primary' : 'default'" quaternary @click="agentMode = !agentMode">
              <template #icon>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 0 1 4 4v2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h2V6a4 4 0 0 1 4-4z"/></svg>
              </template>
              {{ agentMode ? $t('chat.agentMode') : $t('chat.chatMode') }}
            </n-button>
          </template>
          {{ $t('chat.agentDesc') }}
        </n-tooltip>
        <n-button size="small" quaternary @click="handleNewChat">
          <template #icon>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          {{ $t('chat.newChat') }}
        </n-button>
      </div>
    </header>

    <!-- Messages -->
    <div class="messages-area" ref="messagesRef">
      <!-- Welcome -->
      <div v-if="messages.length === 0" class="welcome-area">
        <div class="welcome-logo">DA</div>
        <h1 class="welcome-title">DeepSeek Agent</h1>
        <p class="welcome-subtitle">{{ $t('chat.welcomeDesc') }}</p>
        <div class="quick-prompts">
          <div class="quick-prompt" @click="sendQuick('帮我写一个 Python 快速排序函数，并测试它')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            {{ locale === 'en-US' ? 'Write & test code' : '写代码并执行测试' }}
          </div>
          <div class="quick-prompt" @click="sendQuick('用中文搜索并总结今天的 AI 领域重要新闻')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            {{ locale === 'en-US' ? 'Search latest AI news' : '搜索最新 AI 资讯' }}
          </div>
          <div class="quick-prompt" @click="sendQuick('请记住：我喜欢简洁的中文回答，用表格式呈现数据')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            {{ locale === 'en-US' ? 'Teach Agent preferences' : '让 Agent 记住偏好' }}
          </div>
        </div>
      </div>

      <!-- Messages -->
      <div
        v-for="msg in messages"
        :key="msg.id"
        class="message-wrapper"
      >
        <div class="message" :class="msg.role">
          <div class="message-header">
            <div class="message-avatar">
              {{ msg.role === 'user' ? 'U' : 'AI' }}
            </div>
            <div class="message-meta">
              <span class="message-role">{{ msg.role === 'user' ? $t('chat.roleUser') : $t('chat.roleAssistant') }}</span>
              <span class="message-time">{{ formatTime(msg.createdAt) }}</span>
            </div>
          </div>
          <div class="message-body">
            <!-- 附件展示 -->
            <div v-if="msg.attachments && msg.attachments.length > 0" class="message-attachments">
              <div
                v-for="att in msg.attachments"
                :key="att.id"
                class="attachment-card"
                @click="openAttachment(att)"
              >
                <div class="attachment-preview">
                  <img
                    v-if="isImageType(att.type)"
                    :src="att.url"
                    :alt="att.name"
                    class="attachment-image"
                  />
                  <div v-else class="attachment-file-icon">
                    <svg v-if="isPdfType(att.type)" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <svg v-else-if="isSheetType(att.type)" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>
                    <svg v-else-if="isDocType(att.type)" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                    <svg v-else width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  </div>
                </div>
                <div class="attachment-info">
                  <span class="attachment-name">{{ att.name }}</span>
                  <span class="attachment-size">{{ formatFileSize(att.size) }}</span>
                </div>
              </div>
            </div>

            <!-- 思考状态 -->
            <div v-if="msg.role === 'assistant' && chatStore.isLoading && !msg.content && (!msg.toolCalls || msg.toolCalls.length === 0) && (!msg.thinking || msg.thinking.length === 0)" class="typing-indicator">
              <span class="dot"></span>
              <span class="dot"></span>
              <span class="dot"></span>
            </div>
            <!-- 技能匹配 -->
            <div v-if="msg.skills && msg.skills.length" class="skill-match-row">
              <span v-for="s in msg.skills" :key="s.name" class="skill-tag">⚡ {{ s.name }}</span>
            </div>
            <!-- Planner 执行计划 -->
            <div v-if="msg.planner && msg.planner.steps && msg.planner.steps.length" class="planner-card">
              <div class="planner-title">📋 执行计划</div>
              <div v-for="(step, i) in msg.planner.steps" :key="i" class="planner-step">{{ step }}</div>
            </div>
            <!-- 思考步骤 -->
            <ThinkingBlock
              v-for="(think, idx) in (msg.thinking || [])"
              :key="'think-' + idx"
              :message="think.message || ''"
              :turn="think.turn"
              :completed="think.completed"
              :reasoning="think.reasoning"
            />
            <!-- 工具调用 -->
            <ToolCallBlock
              v-for="tc in (msg.toolCalls || [])"
              :key="tc.id"
              :tool-name="tc.name"
              :args="tc.arguments"
              :result="tc.result"
              :status="tc.status"
              :duration="tc.duration"
              @allow="onToolAllow(tc)"
              @deny="onToolDeny(tc)"
            />
            <!-- 重试提示 -->
            <div v-if="msg.retrying" class="retry-hint">🔄 {{ msg.retrying }}</div>
            <!-- 文本内容 -->
            <div v-if="msg.content" class="message-content" v-html="renderMarkdown(textOf(msg.content))"></div>
            <!-- 交付摘要 -->
            <div v-if="msg.deliverySummary && msg.deliverySummary.artifacts.length" class="delivery-summary">
              <div class="ds-title">📦 交付产物 ({{ msg.deliverySummary.artifactCount }})</div>
              <div v-for="(a, i) in msg.deliverySummary.artifacts" :key="i" class="ds-item">
                <span class="ds-icon">📄</span>
                <span class="ds-name">{{ a.name }}</span>
                <span class="ds-path">{{ a.path }}</span>
              </div>
            </div>

            <!-- Token usage -->
            <div v-if="msg.role === 'assistant' && msg.tokenCount" class="message-tokens">
              <span>{{ msg.tokenCount }} tokens</span>
              <span v-if="msg.cost"> · ¥{{ msg.cost.toFixed(2) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Input area -->
    <footer class="input-area">
      <div class="input-container">
        <!-- 文件预览列表（上传后但发送前） -->
        <div v-if="uploadedFiles.length > 0" class="file-preview-list">
          <div v-for="(file, idx) in uploadedFiles" :key="file.id || idx" class="file-preview-item">
            <div class="file-preview-icon">
              <svg v-if="isImageType(file.type)" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              <svg v-else-if="isPdfType(file.type)" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <svg v-else-if="isDocType(file.type)" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              <svg v-else-if="isSheetType(file.type)" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>
              <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </div>
            <span class="file-preview-name">{{ file.name }}</span>
            <span class="file-preview-size">{{ formatFileSize(file.size) }}</span>
            <button class="file-preview-remove" @click="removeFile(idx)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>

        <div class="input-row">
          <!-- 上传按钮 -->
          <label class="upload-button" :class="{ disabled: chatStore.isLoading }" title="上传文件（图片/PDF/Word/Excel等）">
            <input
              type="file"
              multiple
              :accept="acceptTypes"
              :disabled="chatStore.isLoading"
              @change="handleFileSelect"
              hidden
              ref="fileInputRef"
            />
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          </label>

          <n-input
            v-model:value="inputText"
            type="textarea"
            :placeholder="'输入消息，Enter 发送  |  Shift+Enter 换行  |  📎 上传文件'"
            :autosize="{ minRows: 1, maxRows: 5 }"
            :disabled="chatStore.isLoading"
            @keydown.enter.exact.prevent="handleSend"
            @keydown.shift.enter.exact=""
            class="chat-input"
            ref="inputRef"
          />
          <n-button
            type="primary"
            :disabled="!canSend && !chatStore.isLoading"
            @click="handleSend"
            class="send-button"
          >
            <template v-if="chatStore.isLoading">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
            </template>
            <template v-else>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </template>
          </n-button>
        </div>
        <div class="input-hint">
          <span>{{ getModelShortName(appStore.currentModel) }}</span>
          <span v-if="uploadedFiles.length > 0"> · {{ uploadedFiles.length }} 个文件</span>
        </div>
      </div>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useChatStore } from '@/stores/chat'
import { useAppStore } from '@/stores/app'
import { getModelShortName } from '@/data/models'
import type { ChatMessage, Attachment, ToolCallEvent } from '@/types'
import { extractText } from '@/types'
import ThinkingBlock from '@/components/chat/ThinkingBlock.vue'
import ToolCallBlock from '@/components/chat/ToolCallBlock.vue'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/github-dark.css'

const chatStore = useChatStore()
const appStore = useAppStore()
const nMessage = useMessage()

const { locale } = useI18n()
const inputText = ref('')
const messagesRef = ref<HTMLElement>()
const inputRef = ref()
const fileInputRef = ref<HTMLInputElement>()
const abortController = ref<AbortController | null>(null)
const agentMode = ref(true)
const uploadedFiles = ref<Attachment[]>([])
const uploading = ref(false)

const acceptTypes = '.jpg,.jpeg,.png,.gif,.webp,.svg,.bmp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.html,.css,.js,.json,.md,.xml,.yaml,.yml,.zip,.tar.gz,.gz'

const md: MarkdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch {}
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`
  },
})

const currentSession = computed(() => chatStore.currentSession)
const messages = computed(() => chatStore.currentMessages)
const canSend = computed(() => inputText.value.trim() || uploadedFiles.value.length > 0)

// ---- 文件类型判断 ----
function isImageType(mime: string) { return mime.startsWith('image/') }
function isPdfType(mime: string) { return mime === 'application/pdf' }
function isDocType(mime: string) { return mime.includes('word') || mime.includes('document') }
function isSheetType(mime: string) { return mime.includes('excel') || mime.includes('spreadsheet') }

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// ---- 文件上传处理 ----
async function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  const rawFiles = input.files
  if (!rawFiles || rawFiles.length === 0) return

  uploading.value = true
  const formData = new FormData()

  // Add session_id for association
  if (chatStore.currentSession?.id) {
    formData.append('session_id', chatStore.currentSession.id)
  }

  for (let i = 0; i < rawFiles.length; i++) {
    formData.append('files', rawFiles[i])
  }

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || '上传失败')
    }

    const data = await res.json()
    uploadedFiles.value.push(...data.files)
  } catch (err: any) {
    nMessage.error(`文件上传失败：${err.message}`)
  } finally {
    uploading.value = false
    // Reset input so same file can be re-selected
    if (fileInputRef.value) fileInputRef.value.value = ''
  }
}

function removeFile(index: number) {
  uploadedFiles.value.splice(index, 1)
}

function openAttachment(att: Attachment) {
  window.open(att.url, '_blank')
}

// ---- Markdown / Utility ----
function renderMarkdown(content: string) {
  if (!content) return ''
  return md.render(content)
}

/** 统一 content 取值：兼容 string（流式）与 ContentBlock[]（历史消息） */
function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  return extractText(content)
}

function formatTime(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesRef.value) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight
    }
  })
}

watch(() => messages.value.length, scrollToBottom)
watch(() => messages.value[messages.value.length - 1]?.content, scrollToBottom)

function sendQuick(text: string) {
  inputText.value = text
  handleSend()
}

function handleNewChat() {
  chatStore.createSession()
  inputText.value = ''
  uploadedFiles.value = []
}

/**
 * 构造 API 消息
 * DeepSeek API 仅支持纯文本，不支持 image_url 多模态
 * 图片附件作为文本引用附在消息中
 */
function buildAPIMessage(m: ChatMessage) {
  const images = (m.attachments || []).filter(a => a.type.startsWith('image/'))
  const docs = (m.attachments || []).filter(a => !a.type.startsWith('image/'))

  if (images.length === 0 && docs.length === 0) {
    return { role: m.role, content: textOf(m.content) }
  }

  let content = textOf(m.content)
  if (images.length > 0) {
    const imgNames = images.map(i => i.name).join(', ')
    content += `\n\n[用户上传了 ${images.length} 张图片: ${imgNames}]`
    for (const img of images) {
      content += `\n[图片URL: ${img.url}]`
    }
  }
  if (docs.length > 0) {
    const docNames = docs.map(d => d.name).join(', ')
    content += `\n\n[用户上传了 ${docs.length} 个文件: ${docNames}]`
  }

  return { role: m.role, content }
}

async function handleSend() {
  if (chatStore.isLoading) {
    abortController.value?.abort()
    chatStore.setLoading(false)
    return
  }

  const text = inputText.value.trim()
  const files = [...uploadedFiles.value]

  if (!text && files.length === 0) return

  let session = chatStore.currentSession
  if (!session) {
    session = await chatStore.createSession(text.slice(0, 50))
  }

  const userMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: text || '[文件]',
    createdAt: new Date().toISOString(),
    attachments: files.length > 0 ? files : undefined,
  }
  await chatStore.addMessage(session.id, userMsg)

  const assistantMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    toolCalls: [],
    thinking: [],
  }
  chatStore.addMessage(session.id, assistantMsg)
  chatStore.setLoading(true)
  inputText.value = ''
  uploadedFiles.value = []
  abortController.value = new AbortController()

  try {
    const apiMessages = messages.value
      .filter((m) => m.id !== assistantMsg.id)
      .map((m) => buildAPIMessage(m))

    if (agentMode.value) {
      await sendAgentMessage(assistantMsg, apiMessages)
    } else {
      await sendSimpleStream(assistantMsg, apiMessages)
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      const cur = messages.value.find((m) => m.id === assistantMsg.id)
      if (cur) cur.content = `❌ 请求失败：${err.message || '请检查 API Key 配置或网络连接'}`
    }
  } finally {
    chatStore.setLoading(false)
    abortController.value = null
    if (session) {
      // 估算 token 数（中英混合粗略 0.6 token/字符），供用量统计使用
      assistantMsg.tokenCount = Math.ceil(textOf(assistantMsg.content).length * 0.6)
      chatStore.persistLastMessage(session.id)
    }
  }
}

/**
 * Agent 模式 — 使用 /api/chat/agent，处理 named SSE 事件
 */
async function sendAgentMessage(assistantMsg: ChatMessage, apiMessages: Array<{ role: string; content: string }>) {
  const res = await fetch('/api/chat/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: apiMessages, model: appStore.currentModel }),
    signal: abortController.value!.signal,
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim()
      } else if (line.startsWith('data: ')) {
        const dataStr = line.slice(6).trim()
        try {
          const data = JSON.parse(dataStr)
          handleAgentEvent(currentEvent, data, assistantMsg)
        } catch {}
        currentEvent = ''
      }
    }
  }
}

function handleAgentEvent(event: string, data: any, msg: ChatMessage) {
  switch (event) {
    case 'thinking': {
      if (!msg.thinking) msg.thinking = []
      msg.thinking.push({ turn: data.turn, message: data.message, completed: false, reasoning: '' })
      break
    }
    case 'thinking_chunk': {
      // 真实推理内容 → 累积到当前 thinking 块
      if (!msg.thinking) msg.thinking = []
      if (msg.thinking.length === 0) {
        msg.thinking.push({ turn: data.turn || 1, message: '思考中...', completed: false, reasoning: '' })
      }
      const last = msg.thinking[msg.thinking.length - 1]
      last.reasoning = (last.reasoning || '') + (data.text || '')
      break
    }
    case 'tool_call': {
      if (!msg.toolCalls) msg.toolCalls = []
      msg.toolCalls.push({
        id: data.id,
        name: data.name,
        arguments: data.arguments,
        status: data.status === 'pending' ? 'pending' : 'running',
        startedAt: Date.now(),
      })
      break
    }
    case 'tool_result': {
      if (msg.toolCalls) {
        const target = [...msg.toolCalls].reverse().find(
          (tc) => tc.name === data.name && tc.status !== 'done' && tc.status !== 'error'
        )
        if (target) {
          target.result = data.content
          target.status = 'done'
        }
      }
      break
    }
    case 'tool_duration': {
      if (msg.toolCalls) {
        const target = [...msg.toolCalls].reverse().find((tc) => tc.name === data.name && !tc.duration)
        if (target) target.duration = Math.round((data.duration || 0) * 10) / 10
      }
      break
    }
    case 'skill_matched': {
      if (!msg.skills) msg.skills = []
      if (!msg.skills.some((s) => s.name === data.name)) msg.skills.push({ name: data.name })
      break
    }
    case 'planner_plan': {
      msg.planner = { steps: data.steps || [], raw: data.raw || '' }
      break
    }
    case 'content_chunk': {
      // 打字机：逐字累积
      const text = data.text || ''
      if (typeof msg.content === 'string') {
        msg.content += text
      } else if (Array.isArray(msg.content)) {
        const last = msg.content[msg.content.length - 1]
        if (last && last.type === 'text') last.text += text
        else msg.content.push({ type: 'text', text })
      } else {
        msg.content = text
      }
      break
    }
    case 'content': {
      msg.content = data.content
      markThinkingDone(msg)
      break
    }
    case 'delivery_summary': {
      msg.deliverySummary = {
        artifactCount: data.artifactCount || 0,
        artifacts: data.artifacts || [],
        toolCallCount: data.toolCallCount || 0,
        turns: data.turns || 0,
      }
      break
    }
    case 'done': {
      markThinkingDone(msg)
      break
    }
    case 'error': {
      if (data.retrying) {
        msg.retrying = data.message || '正在重试...'
      } else {
        msg.content = `❌ ${data.message}`
        markThinkingDone(msg)
      }
      break
    }
  }
}

/** 将最后一个 thinking 块标记为完成（内容产出或结束时） */
function markThinkingDone(msg: ChatMessage) {
  if (msg.thinking && msg.thinking.length > 0) {
    const last = msg.thinking[msg.thinking.length - 1]
    last.completed = true
  }
}

/** 工具确认：当前版本后端对敏感工具发 pending 后仍会执行，确认仅更新前端展示状态（后端真拦截在安全批次做） */
function onToolAllow(tc: ToolCallEvent) {
  tc.status = 'running'
}
function onToolDeny(tc: ToolCallEvent) {
  tc.status = 'error'
  tc.result = '用户拒绝执行此操作'
}

/**
 * 简单聊天模式 — 使用 /api/chat/stream，原始 SSE 流式
 */
async function sendSimpleStream(assistantMsg: ChatMessage, apiMessages: Array<{ role: string; content: string }>) {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: apiMessages, model: appStore.currentModel }),
    signal: abortController.value!.signal,
  })

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        try {
          const chunk = JSON.parse(data)
          const content = chunk.choices?.[0]?.delta?.content
          if (content) {
            const cur = messages.value.find((m) => m.id === assistantMsg.id)
            if (cur) cur.content += content
          }
        } catch {}
      }
    }
  }
}

onMounted(async () => {
  await chatStore.loadSessions()
  if (!chatStore.currentSession) {
    await chatStore.createSession()
  }
})
</script>

<style scoped>
/* ---- Agent 过程展示（技能/Planner/重试/交付摘要） ---- */
.skill-match-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 0;
}

.skill-tag {
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--accent-muted, rgba(129, 140, 248, 0.12));
  color: var(--accent);
  border: 1px solid var(--border-color);
}

.planner-card {
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-tertiary);
}

.planner-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--text-secondary);
}

.planner-step {
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-secondary);
  padding-left: 4px;
}

.retry-hint {
  font-size: 12px;
  color: var(--warning, #eab308);
  padding: 4px 0;
}

.delivery-summary {
  margin: 10px 0;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-tertiary);
}

.ds-title {
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 6px;
}

.ds-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 3px 0;
}

.ds-name {
  font-weight: 500;
  flex-shrink: 0;
}

.ds-path {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* ===== Header ===== */
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-primary);
  flex-shrink: 0;
}

.chat-title-area {
  display: flex;
  align-items: center;
  gap: 10px;
}

.chat-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}

.model-badge {
  font-size: 11px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ===== Messages ===== */
.messages-area {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.welcome-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  gap: 16px;
}

.welcome-logo {
  width: 72px;
  height: 72px;
  border-radius: 20px;
  background: linear-gradient(135deg, #4F46E5, #06B6D4);
  color: white;
  font-weight: bold;
  font-size: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8px 24px rgba(79, 70, 229, 0.3);
}

.welcome-title {
  font-size: 24px;
  font-weight: 700;
  margin: 0;
}

.welcome-subtitle {
  font-size: 14px;
  color: var(--text-secondary);
  max-width: 420px;
  line-height: 1.6;
  margin: 0;
}

.quick-prompts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.quick-prompt {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 20px;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  font-size: 14px;
  color: var(--text-primary);
  min-width: 360px;
}

.quick-prompt:hover {
  background: var(--bg-secondary);
  border-color: var(--accent);
}

.message-wrapper {
  margin-bottom: 8px;
}

.message {
  max-width: 800px;
  margin: 0 auto;
}

.message-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  padding-left: 4px;
}

.message-avatar {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.message.user .message-avatar {
  background: linear-gradient(135deg, #4F46E5, #6366F1);
  color: white;
}

.message.assistant .message-avatar {
  background: linear-gradient(135deg, #06B6D4, #0EA5E9);
  color: white;
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.message-role {
  font-size: 13px;
  font-weight: 600;
}

.message-time {
  font-size: 11px;
  color: var(--text-muted);
}

.message-body {
  padding-left: 38px;
}

/* ===== Attachments in messages ===== */
.message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.attachment-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
  max-width: 180px;
  background: var(--bg-secondary);
}

.attachment-card:hover {
  border-color: var(--accent);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.attachment-preview {
  width: 180px;
  height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
  overflow: hidden;
}

.attachment-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.attachment-file-icon {
  display: flex;
  align-items: center;
  justify-content: center;
}

.attachment-info {
  padding: 6px 10px 8px;
  text-align: center;
  width: 100%;
}

.attachment-name {
  font-size: 11px;
  font-weight: 500;
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}

.attachment-size {
  font-size: 10px;
  color: var(--text-muted);
}

/* ===== File preview in input ===== */
.file-preview-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
  padding: 6px;
  border-radius: 8px;
  background: var(--bg-secondary);
}

.file-preview-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  font-size: 12px;
}

.file-preview-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.file-preview-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.file-preview-size {
  color: var(--text-muted);
  font-size: 10px;
  flex-shrink: 0;
}

.file-preview-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-muted);
  transition: background 0.15s, color 0.15s;
  flex-shrink: 0;
  padding: 0;
}

.file-preview-remove:hover {
  background: #fee2e2;
  color: #ef4444;
}

/* ===== Upload Button ===== */
.upload-button {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  flex-shrink: 0;
  color: var(--text-secondary);
}

.upload-button:hover {
  background: var(--bg-primary);
  border-color: var(--accent);
  color: var(--accent);
}

.upload-button.disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.message-content {
  font-size: 14px;
  line-height: 1.75;
  color: var(--text-primary);
}

.message-content :deep(pre) {
  margin: 12px 0;
  border-radius: 10px;
  overflow-x: auto;
  background: #1e1e2e;
  padding: 16px;
  font-size: 13px;
  border: 1px solid var(--border-color);
}

.message-content :deep(code) {
  font-family: 'JetBrains Mono', 'Fira Code', 'SF Mono', monospace;
  font-size: 13px;
}

.message-content :deep(p code) {
  background: var(--bg-secondary);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 13px;
  border: 1px solid var(--border-color);
}

.message-content :deep(blockquote) {
  border-left: 3px solid var(--accent);
  margin: 12px 0;
  padding: 4px 16px;
  color: var(--text-secondary);
}

.message-content :deep(ul), .message-content :deep(ol) {
  padding-left: 24px;
}

.message-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 12px 0;
}

.message-content :deep(th), .message-content :deep(td) {
  border: 1px solid var(--border-color);
  padding: 8px 12px;
  text-align: left;
}

.message-content :deep(th) {
  background: var(--bg-secondary);
}

.message-tokens {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 8px;
}

/* ===== Typing indicator ===== */
.typing-indicator {
  display: flex;
  gap: 4px;
  padding: 4px 0;
}

.typing-indicator .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  animation: typing 1.4s infinite ease-in-out;
}

.typing-indicator .dot:nth-child(2) { animation-delay: 0.2s; }
.typing-indicator .dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes typing {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-8px); opacity: 1; }
}

/* ===== Input ===== */
.input-area {
  border-top: 1px solid var(--border-color);
  background: var(--bg-primary);
  flex-shrink: 0;
}

.input-container {
  max-width: 800px;
  margin: 0 auto;
  padding: 12px 20px 16px;
}

.input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}

.chat-input {
  flex: 1;
}

.send-button {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  padding: 0;
  border-radius: 10px;
}

.input-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
  text-align: center;
}
</style>
