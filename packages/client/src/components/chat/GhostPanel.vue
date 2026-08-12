<template>
  <div class="ghost-panel">
    <div class="tab-hint">{{ $t('ghost.hint') }}</div>

    <div v-if="suggestions.length === 0" class="ghost-empty">
      {{ $t('ghost.empty') }}
    </div>

    <div v-for="s in suggestions" :key="s.id" class="ghost-item" :class="{ executed: s.executed }">
      <div class="ghost-head">
        <span class="ghost-badge">👻</span>
        <span class="ghost-file">{{ shortFile(s.file) }}</span>
        <span class="ghost-time">{{ shortTime(s.time) }}</span>
      </div>
      <div class="ghost-suggestion">{{ s.suggestion }}</div>
      <div class="ghost-foot">
        <span class="ghost-reason" :title="s.reason">{{ s.reason }}</span>
        <span class="ghost-conf">{{ $t('ghost.confidence', { n: Math.round(s.confidence * 100) }) }}</span>
        <button v-if="!s.executed" class="ghost-exec" @click="execute(s)">▶ {{ $t('ghost.execute') }}</button>
        <span v-else class="ghost-done">✓ {{ $t('ghost.executed') }}</span>
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
.ghost-suggestion { font-size: 12px; line-height: 1.6; margin-bottom: 6px; }
.ghost-foot { display: flex; align-items: center; gap: 8px; }
.ghost-reason {
  flex: 1;
  font-size: 10px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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
