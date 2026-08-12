<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h2>历史记录</h2>
        <p class="page-desc">这里按来源只读查看 SuperCrzy 历史会话。</p>
      </div>
      <n-input v-model:value="searchText" placeholder="搜索会话..." clearable class="search-input">
        <template #prefix><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></template>
      </n-input>
    </header>

    <div class="history-list" v-if="filteredSessions.length > 0">
      <div v-for="(group, source) in groupedSessions" :key="source" class="source-group">
        <div class="source-header" @click="toggleGroup(source as string)">
          <div class="source-info">
            <span class="source-icon">
              <SvgIcon :name="getSourceIcon(source as string)" :size="16" />
            </span>
            <span class="source-name">{{ source }}</span>
            <n-tag size="tiny" :bordered="false" type="info">{{ group.length }}</n-tag>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: expandedGroups[source as string] }">
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </div>
        <div v-show="expandedGroups[source as string]" class="source-sessions">
          <div v-for="s in group" :key="s.id" class="history-item">
            <div class="history-item-icon" @click="viewSession(s)">
              <SvgIcon name="messages" :size="16" />
            </div>
            <div class="history-item-content" @click="viewSession(s)">
              <div class="history-item-title">{{ s.first_msg || s.title || '新对话' }}</div>
              <div class="history-item-meta">
                <span>{{ s.model }}</span>
                <span>·</span>
                <span>{{ formatDate(s.updatedAt || s.updated_at || '') }}</span>
                <span v-if="s.message_count">· {{ s.message_count }} 条消息</span>
              </div>
            </div>
            <n-button size="tiny" quaternary type="primary" @click="continueChat(s)">Continue</n-button>
          </div>
        </div>
      </div>
    </div>

    <n-empty v-else description="暂无历史记录" class="empty-state" />

    <!-- Session Detail Modal -->
    <n-modal v-model:show="showDetail" preset="card" title="对话详情" style="width:800px;max-height:80vh">
      <div class="detail-messages" v-if="detailMessages.length">
        <div v-for="msg in detailMessages" :key="msg.id" class="detail-msg" :class="msg.role">
          <div class="detail-msg-header">
            <span class="detail-msg-role">{{ msg.role === 'user' ? 'You' : 'SuperCrzy' }}</span>
            <span class="detail-msg-time">{{ formatTime(msg.created_at || msg.createdAt) }}</span>
          </div>
          <div class="detail-msg-content">{{ msg.content }}</div>
        </div>
      </div>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import SvgIcon from '@/components/ui/SvgIcon.vue'

const router = useRouter()
const chatStore = useChatStore()

function getSourceIcon(src: string): string {
  const map: Record<string, string> = { 'Web UI': 'monitor', 'CLI': 'terminal', 'API': 'plug', 'WeChat': 'message' }
  return map[src] || 'folder'
}

interface HistorySession {
  id: string
  title: string
  model: string
  first_msg?: string
  updated_at?: string
  updatedAt?: string
  message_count?: number
  source?: string
}

const sessions = ref<HistorySession[]>([])
const searchText = ref('')
const showDetail = ref(false)
const detailMessages = ref<any[]>([])
const expandedGroups = reactive<Record<string, boolean>>({})

const filteredSessions = computed(() => {
  if (!searchText.value) return sessions.value
  const q = searchText.value.toLowerCase()
  return sessions.value.filter(s =>
    (s.title || '').toLowerCase().includes(q) ||
    (s.first_msg || '').toLowerCase().includes(q) ||
    (s.model || '').toLowerCase().includes(q)
  )
})

const groupedSessions = computed(() => {
  const groups: Record<string, HistorySession[]> = {}
  for (const s of filteredSessions.value) {
    const src = s.source || 'Default'
    if (!groups[src]) groups[src] = []
    groups[src].push(s)
  }
  return groups
})

function toggleGroup(src: string) {
  expandedGroups[src] = !expandedGroups[src]
}

async function viewSession(s: HistorySession) {
  try {
    const res = await fetch(`/api/history/${s.id}`)
    if (res.ok) {
      const data = await res.json()
      detailMessages.value = data.messages || []
      showDetail.value = true
    }
  } catch {}
}

async function continueChat(s: HistorySession) {
  // Navigate to Chat with this session
  await chatStore.selectSession(s.id)
  router.push('/')
}

function formatDate(d: string) {
  if (!d) return ''
  const date = new Date(d)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  if (diff < 86400000) return '今天'
  if (diff < 172800000) return '昨天'
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function formatTime(d: string) {
  return new Date(d).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

onMounted(async () => {
  try {
    const res = await fetch('/api/history')
    if (res.ok) sessions.value = await res.json()
  } catch {}
})
</script>

<style scoped>
.page-container { height: 100vh; display: flex; flex-direction: column; }
.page-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--border-color); flex-shrink: 0; }
.page-header h2 { font-size: 16px; font-weight: 600; margin: 0; }
.page-desc { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }
.search-input { width: 240px; }
.history-list { flex: 1; overflow-y: auto; padding: 12px 24px; }
.source-group { margin-bottom: 16px; }
.source-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-radius: 8px; cursor: pointer; transition: background 0.15s; }
.source-header:hover { background: var(--bg-secondary); }
.source-info { display: flex; align-items: center; gap: 8px; }
.source-name { font-size: 13px; font-weight: 600; }
.source-sessions { padding-left: 24px; }
.source-header svg { transition: transform 0.2s; }
.source-header svg.rotated { transform: rotate(180deg); }
.history-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; cursor: pointer; transition: background 0.15s; }
.history-item:hover { background: var(--bg-secondary); }
.history-item-icon { font-size: 16px; flex-shrink: 0; }
.history-item-content { flex: 1; min-width: 0; }
.history-item-title { font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-item-meta { font-size: 11px; color: var(--text-muted); margin-top: 2px; display: flex; gap: 4px; align-items: center; }
.empty-state { margin-top: 80px; }
.detail-messages { max-height: 60vh; overflow-y: auto; }
.detail-msg { margin-bottom: 16px; }
.detail-msg-header { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
.detail-msg-role { font-size: 12px; font-weight: 600; }
.detail-msg-time { font-size: 11px; color: var(--text-muted); }
.detail-msg-content { font-size: 13px; line-height: 1.7; padding: 8px 12px; border-radius: 8px; background: var(--bg-secondary); white-space: pre-wrap; word-break: break-word; }
</style>
