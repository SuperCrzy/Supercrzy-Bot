<template>
  <div class="ghost-panel">
    <div class="tab-hint">{{ $t('ghost.hint') }}</div>

    <div v-if="suggestions.length === 0" class="ghost-empty">
      {{ $t('ghost.empty') }}
    </div>

    <div v-for="s in suggestions" :key="s.id" class="ghost-item" :class="{ executed: s.executed }">
      <div class="ghost-head">
        <svg class="ghost-badge" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a7 7 0 0 0-7 7v7h14v-7a7 7 0 0 0-7-7z"/><path d="M8 14h.01M16 14h.01M8 18v3M16 18v3"/></svg>
        <span class="ghost-file">{{ shortFile(s.file) }}</span>
        <span class="ghost-time">{{ shortTime(s.time) }}</span>
      </div>
      <div class="ghost-suggestion">{{ s.suggestion }}</div>
      <div class="ghost-reason" :title="s.reason">{{ s.reason }}</div>
      <div class="ghost-foot">
        <span class="ghost-conf">{{ $t('ghost.confidence', { n: Math.round(s.confidence * 100) }) }}</span>
        <button v-if="!s.executed" class="ghost-exec" @click="execute(s)">{{ $t('ghost.execute') }}</button>
        <span v-else class="ghost-done">{{ $t('ghost.executed') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useChatStore } from '@/stores/chat'

interface GhostSuggestion {
  id: string
  time: string
  file: string
  type: string
  reason: string
  suggestion: string
  confidence: number
  executed: boolean
}

const chatStore = useChatStore()
const suggestions = ref<GhostSuggestion[]>([])
let timer: ReturnType<typeof setInterval> | null = null

async function load() {
  try {
    const res = await fetch('/api/ghost/suggestions')
    if (res.ok) suggestions.value = await res.json()
  } catch { /* ignore */ }
}

/** 执行：建议作为用户消息自动发送给 Agent */
function execute(s: GhostSuggestion) {
  chatStore.pendingMessage = s.suggestion
  s.executed = true
  fetch(`/api/ghost/${s.id}/executed`, { method: 'POST' }).catch(() => {})
}

function shortFile(p: string) {
  const parts = p.split('/')
  return parts.slice(-3).join('/')
}

function shortTime(t: string) {
  return t ? t.replace('T', ' ').slice(5, 16) : ''
}

onMounted(() => {
  load()
  timer = setInterval(load, 15000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.ghost-panel { padding: 4px 2px; font-size: 12px; }
.ghost-empty { font-size: 12px; color: var(--text-muted); padding: 8px 0; line-height: 1.6; }

.ghost-item {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
  transition: opacity 0.2s;
}
.ghost-item.executed { opacity: 0.5; }
.ghost-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.ghost-badge { font-size: 13px; }
.ghost-file {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ghost-time { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
.ghost-suggestion { font-size: 12px; line-height: 1.6; margin-bottom: 4px; }
.ghost-reason {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.5;
  margin-bottom: 8px;
  word-break: break-all;
}
.ghost-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ghost-conf { font-size: 10px; color: var(--accent); flex-shrink: 0; }
.ghost-exec {
  flex-shrink: 0;
  font-size: 11px;
  padding: 3px 10px;
  color: var(--accent);
  background: transparent;
  border: 1px solid var(--accent);
  border-radius: 6px;
  cursor: pointer;
}
.ghost-exec:hover { background: var(--accent-muted, rgba(129, 140, 248, 0.12)); }
.ghost-done { font-size: 11px; color: var(--success, #22c55e); flex-shrink: 0; }
</style>
