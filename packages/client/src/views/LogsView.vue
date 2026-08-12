<template>
  <div class="page-container">
    <header class="page-header">
      <div class="header-row">
        <div>
          <h2>系统日志</h2>
          <p class="page-desc">实时查看系统运行日志和消息记录</p>
        </div>
        <div class="header-actions">
          <n-input-group size="small" class="search-box">
            <n-input v-model:value="searchQuery" placeholder="搜索日志..." clearable />
            <n-button type="primary" ghost @click="loadLogs">刷新</n-button>
          </n-input-group>
          <n-checkbox v-model:checked="autoRefresh" size="small">自动刷新</n-checkbox>
        </div>
      </div>
      <div class="filter-bar">
        <n-button-group size="tiny">
          <n-button :type="levelFilter === 'all' ? 'primary' : 'default'" @click="levelFilter = 'all'" ghost>全部</n-button>
          <n-button :type="levelFilter === 'info' ? 'info' : 'default'" @click="levelFilter = 'info'" ghost>INFO</n-button>
          <n-button :type="levelFilter === 'warn' ? 'warning' : 'default'" @click="levelFilter = 'warn'" ghost>WARN</n-button>
          <n-button :type="levelFilter === 'error' ? 'error' : 'default'" @click="levelFilter = 'error'" ghost>ERROR</n-button>
          <n-button :type="levelFilter === 'debug' ? 'default' : 'default'" @click="levelFilter = 'debug'" ghost>DEBUG</n-button>
        </n-button-group>
        <span class="log-count">{{ filteredLogs.length }} 条日志</span>
      </div>
    </header>

    <div class="log-list" ref="listRef">
      <div v-for="(l, i) in paginatedLogs" :key="i" class="log-item" :class="l.level">
        <span class="log-time">{{ formatTime(l.time) }}</span>
        <span class="log-level">{{ getLevelLabel(l.level) }}</span>
        <span class="log-type">{{ l.type }}</span>
        <span class="log-msg">
          <template v-if="l.sessionTitle">
            <span class="session-link">{{ l.sessionTitle }}</span> ·
          </template>
          {{ l.message }}
          <span v-if="l.tokens" class="log-tokens">{{ l.tokens }} tokens</span>
        </span>
      </div>
      <n-empty v-if="filteredLogs.length === 0 && !loading" description="暂无日志" class="empty-state" />
      <n-spin v-if="loading" class="loading-spin" />
    </div>

    <div class="log-footer">
      <n-pagination
        v-model:page="page"
        :page-size="pageSize"
        :item-count="filteredLogs.length"
        size="small"
        :page-slot="5"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'

interface LogEntry {
  time: string
  level: 'info' | 'warn' | 'error' | 'debug'
  type: string
  message: string
  sessionTitle?: string
  tokens?: number
}

const logs = ref<LogEntry[]>([])
const loading = ref(false)
const searchQuery = ref('')
const levelFilter = ref<string>('all')
const autoRefresh = ref(false)
const page = ref(1)
const pageSize = 20

let refreshTimer: ReturnType<typeof setInterval> | null = null

const filteredLogs = computed(() => {
  let result = logs.value
  if (levelFilter.value !== 'all') {
    result = result.filter(l => l.level === levelFilter.value)
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(l => l.message.toLowerCase().includes(q) || l.type.toLowerCase().includes(q))
  }
  return result
})

const paginatedLogs = computed(() => {
  const start = (page.value - 1) * pageSize
  return filteredLogs.value.slice(start, start + pageSize)
})

async function loadLogs() {
  loading.value = true
  try {
    const res = await fetch('/api/stats/logs')
    if (res.ok) {
      const data = await res.json()
      logs.value = data.map((m: any) => ({
        time: m.created_at || new Date().toISOString(),
        level: 'info',
        type: m.role === 'user' ? '用户消息' : m.role === 'assistant' ? 'AI回复' : m.role || '系统',
        message: (m.content || '').slice(0, 100),
        sessionTitle: m.session_title || undefined,
      }))
    }
  } catch {}
  loading.value = false
}

function getLevelLabel(level: string) {
  const map: Record<string, string> = { info: 'INFO', warn: 'WARN', error: 'ERROR', debug: 'DEBUG' }
  return map[level] || level.toUpperCase()
}

function formatTime(d: string) {
  return new Date(d).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

watch(autoRefresh, (v) => {
  if (v) {
    refreshTimer = setInterval(loadLogs, 5000)
  } else {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
  }
})

onMounted(loadLogs)
onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer) })
</script>

<style scoped>
.page-container { height: 100vh; display: flex; flex-direction: column; }
.page-header { padding: 16px 20px; border-bottom: 1px solid var(--border-color); flex-shrink: 0; }

.header-row { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
.header-row h2 { font-size: 16px; font-weight: 600; margin: 0; }
.page-desc { font-size: 12px; color: var(--text-muted); margin: 2px 0 0; }

.header-actions { display: flex; gap: 10px; align-items: center; }
.search-box { width: 220px; }

.filter-bar { display: flex; align-items: center; gap: 12px; }
.log-count { font-size: 11px; color: var(--text-muted); white-space: nowrap; }

.log-list { flex: 1; overflow-y: auto; padding: 8px 20px; font-family: var(--font-mono); font-size: 12px; }
.log-item { display: flex; gap: 10px; padding: 5px 8px; border-radius: 4px; line-height: 1.5; align-items: baseline; }
.log-item:hover { background: var(--bg-hover); }

.log-time { color: var(--text-muted); white-space: nowrap; min-width: 70px; font-size: 11px; }
.log-level { font-weight: 700; min-width: 44px; font-size: 11px; flex-shrink: 0; }
.log-type { color: var(--text-secondary); min-width: 60px; font-size: 11px; flex-shrink: 0; }

.log-item.info .log-level { color: #22c55e; }
.log-item.warn .log-level { color: #f59e0b; }
.log-item.error .log-level { color: #ef4444; }
.log-item.debug .log-level { color: #6366f1; }

.log-msg { flex: 1; color: var(--text-primary); word-break: break-all; }
.session-link { color: var(--accent); cursor: pointer; }
.log-tokens { color: var(--text-muted); font-size: 10px; margin-left: 6px; }

.empty-state { margin-top: 80px; }
.loading-spin { display: flex; justify-content: center; padding: 40px; }

.log-footer { padding: 8px 20px; border-top: 1px solid var(--border-color); display: flex; justify-content: center; }
</style>
