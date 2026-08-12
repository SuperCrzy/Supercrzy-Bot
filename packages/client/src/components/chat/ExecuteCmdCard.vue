<template>
  <div class="exec-card" :class="status">
    <div class="ec-header" @click="expanded = !expanded">
      <span class="ec-spinner" v-if="status === 'running'"></span>
      <svg v-else-if="status === 'done'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
      <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--error)" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      <span class="ec-prompt">$</span>
      <code class="ec-cmd">{{ command }}</code>
      <span v-if="duration" class="ec-dur">{{ duration }}s</span>
      <span class="ec-toggle"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: expanded }"><path d="M6 9l6 6 6-6"/></svg></span>
    </div>
    <div v-if="expanded" class="ec-body">
      <pre v-if="output" class="ec-output"><code>{{ output }}</code></pre>
      <div v-else-if="status === 'running'" class="ec-running-hint">{{ $t('chatui.running') }}...</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'

const props = withDefaults(defineProps<{ args?: string; result?: string; status?: string; duration?: number }>(), { args: '', result: '', status: 'done', duration: undefined })

const expanded = ref(props.status === 'running')

// 状态驱动展开/折叠
watch(() => props.status, (s) => {
  if (s === 'running') expanded.value = true
  if (s === 'done') setTimeout(() => { expanded.value = false }, 1000)
  if (s === 'error') expanded.value = true
})

const command = computed(() => {
  try { return JSON.parse(props.args || '{}').command || JSON.parse(props.args || '{}').cmd || '' } catch { return props.args?.slice(0, 80) || '' }
})

const output = computed(() => {
  if (!props.result) return ''
  try { const d = JSON.parse(props.result); return d.output || d.stdout || d.result || d.content || props.result.slice(0, 5000) } catch { return props.result.slice(0, 5000) }
})
</script>

<style scoped>
.exec-card {
  margin: 4px 0;
  border-radius: 8px;
  border: 1px solid var(--border-color, #2a2a3e);
  background: var(--bg-secondary, rgba(255,255,255,0.02));
  overflow: hidden;
  transition: border-color 0.2s;
}
.exec-card.running { border-color: var(--accent-muted, rgba(91,109,255,0.3)); }
.exec-card.error { border-color: var(--error, #ef4444); }
.exec-card.done { opacity: 0.9; }

.ec-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}
.ec-header:hover { background: var(--bg-hover, rgba(255,255,255,0.03)); }

.ec-spinner {
  width: 10px;
  height: 10px;
  border: 2px solid var(--border-color, #2a2a3e);
  border-top-color: var(--accent, #5b6dff);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

.ec-prompt {
  color: var(--success, #22c55e);
  font-family: var(--font-mono, monospace);
  font-weight: 700;
  font-size: 12px;
  flex-shrink: 0;
}

.ec-cmd {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  color: var(--text-primary, #e2e2e2);
}

.ec-dur {
  font-size: 10px;
  color: var(--text-muted, #666);
  font-family: var(--font-mono, monospace);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.ec-toggle { margin-left: auto; display: flex; }
.ec-toggle svg { transition: transform 0.2s; opacity: 0.5; }
.ec-toggle svg.rotated { transform: rotate(180deg); }

.ec-body {
  padding: 0;
  border-top: 1px solid var(--border-color, #2a2a3e);
}

.ec-output {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 400px;
  overflow-y: auto;
  color: var(--text-primary, #c9d1d9);
  background: var(--bg-code, rgba(0,0,0,0.15));
  margin: 0;
  padding: 8px 12px;
}

.ec-running-hint {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-muted, #666);
  font-style: italic;
}
</style>
