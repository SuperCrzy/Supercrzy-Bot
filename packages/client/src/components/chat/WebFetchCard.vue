<template>
  <div class="web-fetch-card">
    <div class="wf-header" @click="expanded = !expanded">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      <span class="wf-title">{{ displayUrl }}</span>
      <span class="wf-toggle">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: expanded }"><path d="M6 9l6 6 6-6"/></svg>
      </span>
    </div>
    <div v-if="expanded" class="wf-body">
      <div v-if="content" class="wf-content">{{ content.slice(0, 2000) }}</div>
      <div v-else class="wf-empty">内容为空</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{ args?: string; result?: string }>()

const expanded = ref(false)

const displayUrl = computed(() => {
  try { const u = JSON.parse(props.args || '{}').url || JSON.parse(props.args || '{}').link || ''; return u.replace(/^https?:\/\//, '') } catch { return '' }
})

const content = computed(() => {
  if (!props.result) return ''
  try {
    const d = JSON.parse(props.result)
    return d.content || d.text || d.summary || d.title || props.result.slice(0, 2000)
  } catch { return props.result.slice(0, 2000) }
})
</script>

<style scoped>
.web-fetch-card {
  margin: 4px 0; border-radius: var(--radius-md);
  border: 1px solid var(--border-color); background: var(--bg-secondary); overflow: hidden;
}
.wf-header {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; font-size: 12px; color: var(--text-secondary); cursor: pointer;
}
.wf-header:hover { background: var(--bg-hover); }
.wf-title { font-family: var(--font-mono); font-size: 11px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.wf-toggle { margin-left: auto; display: flex; }
.wf-toggle svg { transition: transform var(--duration-fast); }
.wf-toggle svg.rotated { transform: rotate(180deg); }
.wf-body { padding: 8px 10px; border-top: 1px solid var(--border-color); }
.wf-content { font-size: 12px; color: var(--text-secondary); line-height: 1.6; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto; }
.wf-empty { font-size: 12px; color: var(--text-muted); text-align: center; padding: 12px; }
</style>
