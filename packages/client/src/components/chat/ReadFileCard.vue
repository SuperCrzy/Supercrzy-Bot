<template>
  <div class="read-card">
    <div class="rc-header" @click="expanded = !expanded">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="rc-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <span class="rc-label">{{ $t('chatui.read') }}</span>
      <span class="rc-path">{{ filePath }}</span>
      <span v-if="fileExt" class="rc-ext">{{ fileExt }}</span>
      <span class="rc-toggle"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: expanded }"><path d="M6 9l6 6 6-6"/></svg></span>
    </div>
    <div v-if="expanded && content" class="rc-body">
      <pre class="rc-content"><code v-html="highlightedContent"></code></pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import hljs from 'highlight.js/lib/common'

const props = withDefaults(defineProps<{ args?: string; result?: string }>(), { args: '', result: '' })

const expanded = ref(false)

const filePath = computed(() => {
  try {
    const a = JSON.parse(props.args || '{}')
    return a.path || a.file_path || ''
  } catch { return '' }
})

const fileExt = computed(() => {
  const path = filePath.value
  return path.includes('.') ? path.split('.').pop() : ''
})

const content = computed(() => {
  if (!props.result) return ''
  try {
    const d = JSON.parse(props.result)
    return (d.content || d.text || d.result || props.result).slice(0, 5000)
  } catch { return props.result.slice(0, 5000) }
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
.read-card {
  margin: 4px 0;
  border-radius: 8px;
  border: 1px solid var(--border-color, #2a2a3e);
  background: var(--bg-secondary, rgba(255,255,255,0.02));
  overflow: hidden;
  transition: border-color 0.2s;
}
.read-card:hover { border-color: var(--border-hover, rgba(255,255,255,0.12)); }

.rc-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.rc-header:hover { background: var(--bg-hover, rgba(255,255,255,0.03)); }

.rc-icon { opacity: 0.5; flex-shrink: 0; }
.rc-label { font-weight: 500; color: var(--text-secondary, #888); flex-shrink: 0; }
.rc-path { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--text-primary, #e2e2e2); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rc-ext { font-size: 10px; padding: 1px 5px; border-radius: 3px; background: var(--accent-bg, rgba(91,109,255,0.1)); color: var(--accent, #5b6dff); font-family: var(--font-mono, monospace); flex-shrink: 0; }

.rc-toggle { margin-left: auto; display: flex; }
.rc-toggle svg { transition: transform 0.2s; opacity: 0.5; }
.rc-toggle svg.rotated { transform: rotate(180deg); }

.rc-body { border-top: 1px solid var(--border-color, #2a2a3e); }
.rc-content {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.6;
  margin: 0;
  padding: 8px 12px;
  background: var(--bg-code, rgba(0,0,0,0.15));
  max-height: 400px;
  overflow-y: auto;
  color: var(--text-primary, #c9d1d9);
}
</style>
