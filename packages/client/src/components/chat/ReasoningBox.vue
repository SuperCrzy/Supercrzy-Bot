<template>
  <div class="reasoning-box" :class="{ completed, streaming: !completed }">
    <div class="reasoning-header" @click="expanded = !expanded">
      <div class="reasoning-icon">
        <svg v-if="!completed" class="reasoning-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/>
          <path d="M9 22h6"/>
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.5">
          <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/>
          <path d="M9 22h6"/>
        </svg>
      </div>
      <span class="reasoning-label">{{ $t('chatui.reasoning') }}</span>
      <span class="reasoning-meta">
        {{ $t('chatui.words', { n: wordCount }) }}
        <svg class="reasoning-chevron" :class="{ open: expanded }" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
      </span>
    </div>
    <div v-if="expanded && message" class="reasoning-content" v-html="renderReasoning(message)"></div>
    <div v-if="!completed" class="reasoning-cursor"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import MarkdownIt from 'markdown-it'

const props = withDefaults(defineProps<{
  message: string
  completed?: boolean
  turn?: number
}>(), {
  completed: false,
})

const expanded = ref(true)

const md = new MarkdownIt({ html: false, linkify: true, typographer: true })

const wordCount = computed(() => {
  if (!props.message) return 0
  return props.message.replace(/\s/g, '').length
})

// 完成后自动收起（延迟 1.5 秒，给用户时间看到结果）
watch(() => props.completed, (done) => {
  if (done) {
    setTimeout(() => { expanded.value = false }, 1500)
  }
})

// 新内容到来时展开
watch(() => props.message, () => {
  if (!props.completed) expanded.value = true
})

function renderReasoning(text: string): string {
  if (!text) return ''
  return md.render(text)
}
</script>

<style scoped>
.reasoning-box {
  margin: 4px 0;
  border-left: 2px solid var(--accent, #5b6dff);
  border-radius: 0 8px 8px 0;
  background: var(--accent-bg, rgba(91,109,255,0.05));
  overflow: hidden;
  transition: all 0.3s ease;
}

.reasoning-box.completed {
  border-left-color: var(--border-color, #2a2a3e);
  background: var(--bg-secondary, rgba(255,255,255,0.02));
  opacity: 0.85;
}

.reasoning-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  color: var(--text-secondary, #888);
  transition: color 0.15s;
}

.reasoning-header:hover {
  color: var(--text-primary, #ddd);
}

.reasoning-icon {
  display: flex;
  align-items: center;
  color: var(--accent, #5b6dff);
}

.reasoning-box.completed .reasoning-icon {
  color: var(--text-secondary, #888);
}

.reasoning-spin {
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.reasoning-label {
  font-weight: 500;
}

.reasoning-turn {
  font-size: 11px;
  opacity: 0.5;
  margin-left: 2px;
}

.reasoning-meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}

.reasoning-chevron {
  transition: transform 0.2s ease;
  opacity: 0.5;
}

.reasoning-chevron.open {
  transform: rotate(180deg);
}

.reasoning-content {
  padding: 0 10px 8px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary, #aaa);
  max-height: 300px;
  overflow-y: auto;
}

.reasoning-content :deep(p) {
  margin: 0 0 6px;
}

.reasoning-content :deep(code) {
  font-size: 12px;
  background: var(--bg-code, rgba(0,0,0,0.2));
  padding: 1px 4px;
  border-radius: 3px;
}

.reasoning-content :deep(pre) {
  margin: 4px 0;
  padding: 6px 8px;
  background: var(--bg-code, rgba(0,0,0,0.2));
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
}

.reasoning-cursor {
  display: inline-block;
  width: 2px;
  height: 14px;
  background: var(--accent, #5b6dff);
  margin-left: 10px;
  margin-bottom: 6px;
  animation: blink 0.8s step-end infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}
</style>
