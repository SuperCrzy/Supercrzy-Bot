<template>
  <div class="process-fold" :class="{ open: expanded, active: isActive }">
    <!-- 折叠态摘要行 -->
    <div class="fold-head" @click="toggle" role="button" tabindex="0" @keydown.enter.prevent="toggle" @keydown.space.prevent="toggle">
      <span class="fold-arrow">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :class="{ rotated: expanded }">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </span>
      <span v-if="isActive && !expanded" class="fold-spinner"></span>
      <span class="fold-summary">
        <template v-if="stats.reasoningCount > 0">
          <span class="fold-segment">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/><path d="M9 22h6"/></svg>
            {{ $t('chatui.reasonCount', { n: stats.reasoningCount }) }}
          </span>
          <span class="fold-dot">·</span>
        </template>
        <span class="fold-segment">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
          {{ $t('chatui.toolCount', { n: stats.toolCallCount }) }}
        </span>
        <span v-if="stats.errorCount > 0" class="fold-error">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          {{ $t('chatui.errorCount', { n: stats.errorCount }) }}
        </span>
        <span v-if="stats.durationMs > 0" class="fold-duration">
          {{ formatDuration(stats.durationMs) }}
        </span>
      </span>
    </div>

    <!-- 展开态内容 -->
    <div v-if="expanded" class="fold-body">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import type { ContentBlock } from '@/types'

const props = withDefaults(defineProps<{
  blocks: ContentBlock[]
  isActive?: boolean
}>(), {
  isActive: false,
})

const expanded = ref(false)

onMounted(() => {
  expanded.value = props.isActive
})

// 活跃时自动展开
watch(() => props.isActive, (active) => {
  if (active) expanded.value = true
})

const stats = computed(() => {
  let toolCallCount = 0
  let reasoningCount = 0
  let errorCount = 0
  let durationMs = 0
  for (const b of props.blocks) {
    if (b.type === 'tool-call') {
      toolCallCount++
      if (b.status === 'error') errorCount++
      if ('duration' in b && b.duration) durationMs += b.duration
    } else if (b.type === 'reasoning') {
      // 只计数有实际内容的 reasoning 块
      if (b.text && b.text.trim().length >= 10) reasoningCount++
    }
  }
  return { toolCallCount, reasoningCount, errorCount, durationMs }
})

function toggle() {
  expanded.value = !expanded.value
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
</script>

<style scoped>
.process-fold {
  margin: 6px 0;
  border: 1px solid var(--border-color, #2a2a3e);
  border-radius: 10px;
  background: var(--bg-secondary, rgba(255,255,255,0.02));
  overflow: hidden;
  transition: border-color 0.2s;
}

.process-fold:hover {
  border-color: var(--border-hover, rgba(255,255,255,0.12));
}

.process-fold.open {
  border-color: var(--accent-muted, rgba(91,109,255,0.3));
}

.process-fold.active {
  border-color: var(--accent, #5b6dff);
}

.fold-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary, #888);
  transition: background 0.15s;
}

.fold-head:hover {
  background: var(--bg-hover, rgba(255,255,255,0.03));
  color: var(--text-primary, #ddd);
}

.fold-arrow {
  display: flex;
  align-items: center;
  transition: transform 0.2s ease;
  opacity: 0.5;
  flex-shrink: 0;
}

.fold-arrow.rotated {
  transform: rotate(90deg);
}

.fold-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--accent-muted, rgba(91,109,255,0.3));
  border-top-color: var(--accent, #5b6dff);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.fold-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.fold-segment {
  display: flex;
  align-items: center;
  gap: 4px;
}

.fold-dot {
  opacity: 0.4;
}

.fold-error {
  display: flex;
  align-items: center;
  gap: 3px;
  color: var(--error, #ef4444);
  font-size: 11px;
}

.fold-duration {
  margin-left: auto;
  font-size: 11px;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}

.fold-body {
  padding: 0 4px 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Dark mode adjustments */
:root.dark .process-fold {
  background: rgba(255,255,255,0.02);
}
</style>
