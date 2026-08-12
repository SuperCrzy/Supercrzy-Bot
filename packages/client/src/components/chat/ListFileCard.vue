<template>
  <div class="list-file-card">
    <div class="lf-header" @click="expanded = !expanded">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span class="lf-title">{{ dirPath || '文件列表' }}</span>
      <span class="lf-count">{{ entries.length }} 项</span>
      <span class="lf-toggle"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: expanded }"><path d="M6 9l6 6 6-6"/></svg></span>
    </div>
    <div v-if="expanded" class="lf-body">
      <div v-for="(e, i) in entries" :key="i" class="lf-entry">
        <svg v-if="e.type === 'directory'" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <svg v-else width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span class="lf-name">{{ e.name }}</span>
        <span class="lf-size" v-if="e.size">{{ formatSize(e.size) }}</span>
        <span class="lf-type" v-else>目录</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'

const props = defineProps<{ args?: string; result?: string }>()

const expanded = ref(false)

const dirPath = computed(() => {
  try { return JSON.parse(props.args || '{}').path || JSON.parse(props.args || '{}').directory || '' } catch { return '' }
})

const entries = computed(() => {
  if (!props.result) return []
  try {
    const d = JSON.parse(props.result)
    if (Array.isArray(d)) return d.slice(0, 30)
    if (d.entries) return d.entries.slice(0, 30)
    if (d.files) return d.files.slice(0, 30)
    return []
  } catch { return [] }
})

function formatSize(bytes: number) { return bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}K` }
</script>

<style scoped>
.list-file-card { margin: 4px 0; border-radius: var(--radius-md); border: 1px solid var(--border-color); background: var(--bg-secondary); overflow: hidden; }
.lf-header { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 12px; cursor: pointer; color: var(--text-secondary); }
.lf-header:hover { background: var(--bg-hover); }
.lf-title { font-weight: 600; color: var(--text-primary); }
.lf-count { font-size: 10px; color: var(--text-muted); }
.lf-toggle { margin-left: auto; }
.lf-toggle svg { transition: transform var(--duration-fast); }
.lf-toggle svg.rotated { transform: rotate(180deg); }
.lf-body { padding: 4px 10px 8px; border-top: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 2px; max-height: 300px; overflow-y: auto; }
.lf-entry { display: flex; align-items: center; gap: 6px; padding: 4px 6px; font-size: 12px; border-radius: 3px; }
.lf-entry:hover { background: var(--bg-hover); }
.lf-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lf-size, .lf-type { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
</style>
