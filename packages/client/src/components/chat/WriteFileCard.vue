<template>
  <div class="write-card" :class="status">
    <div class="wc-header" @click="expanded = !expanded">
      <span class="wc-spinner" v-if="status === 'running'"></span>
      <svg v-else-if="status === 'done'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--error)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="wc-file-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span class="wc-filename">{{ filename }}</span>
      <span v-if="fileExt" class="wc-ext">{{ fileExt }}</span>
      <span class="wc-toggle"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: expanded }"><path d="M6 9l6 6 6-6"/></svg></span>
    </div>
    <div v-if="expanded && content" class="wc-body">
      <pre class="wc-content"><code v-html="highlightedContent"></code></pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import hljs from 'highlight.js/lib/common'

const props = withDefaults(defineProps<{
  toolName?: string
  args?: string
  result?: string
  status?: string
}>(), { args: '', result: '', status: 'done' })

const expanded = ref(false)

watch(() => props.status, (s) => {
  if (s === 'running') expanded.value = true
  if (s === 'done') setTimeout(() => { expanded.value = false }, 800)
})

const filename = computed(() => {
  try {
    const a = JSON.parse(props.args || '{}')
    const path = a.file_path || a.path || a.filePath || ''
    return path.split('/').pop() || path
  } catch { return '' }
})

const fileExt = computed(() => {
  const name = filename.value
  return name.includes('.') ? name.split('.').pop() : ''
})

const content = computed(() => {
  try {
    const a = JSON.parse(props.args || '{}')
    return (a.content || a.text || '').slice(0, 3000)
  } catch { return '' }
})

const highlightedContent = computed(() => {
  if (!content.value) return ''
  const lang = fileExt.value
  if (lang && hljs.getLanguage(lang)) {
    try { return hljs.highlight(content.value, { language: lang }).value } catch {}
  }
  return hljs.highlightAuto(content.value).value
})
</script>

<style scoped>
.write-card {
  margin: 4px 0;
  border-radius: 8px;
  border: 1px solid var(--border-color, #2a2a3e);
  background: var(--bg-secondary, rgba(255,255,255,0.02));
  overflow: hidden;
  transition: border-color 0.2s;
}
.write-card.running { border-color: var(--accent-muted, rgba(91,109,255,0.3)); }
.write-card.error { border-color: var(--error, #ef4444); }
.write-card.done { opacity: 0.9; }

.wc-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.wc-header:hover { background: var(--bg-hover, rgba(255,255,255,0.03)); }

.wc-spinner {
  width: 10px; height: 10px;
  border: 2px solid var(--border-color, #2a2a3e);
  border-top-color: var(--accent, #5b6dff);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

.wc-file-icon { opacity: 0.5; flex-shrink: 0; }
.wc-filename { font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wc-ext { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: var(--accent-bg, rgba(91,109,255,0.1)); color: var(--accent, #5b6dff); font-family: var(--font-mono, monospace); flex-shrink: 0; }

.wc-toggle { margin-left: auto; display: flex; }
.wc-toggle svg { transition: transform 0.2s; opacity: 0.5; }
.wc-toggle svg.rotated { transform: rotate(180deg); }

.wc-body { border-top: 1px solid var(--border-color, #2a2a3e); }
.wc-content {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.6;
  margin: 0;
  padding: 8px 12px;
  background: var(--bg-code, rgba(0,0,0,0.15));
  max-height: 300px;
  overflow-y: auto;
  color: var(--text-primary, #c9d1d9);
}
</style>
