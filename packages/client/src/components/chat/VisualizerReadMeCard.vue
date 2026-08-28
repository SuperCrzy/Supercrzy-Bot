<template>
  <div class="vrm-card" :class="{ executing: isExecuting }">
    <div class="vrm-header" :class="{ expandable: canExpand }" @click="handleToggle">
      <!-- 执行中不显示图标（WorkBuddy 同款：cb-shining-text 闪烁状态词） -->
      <svg v-if="!isExecuting" class="vrm-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 1.6c2.4 0 4.35 1.9 4.35 4.35 0 1.1-.4 2.1-1.05 2.9L14 11.6l-1.1 1.1-2.7-2.7c-.6.35-1.35.6-2.2.6-2.4 0-4.35-1.9-4.35-4.35S5.6 1.6 8 1.6zm0 1.8a2.55 2.55 0 1 0 0 5.1 2.55 2.55 0 0 0 0-5.1z" fill="currentColor"/>
      </svg>
      <span class="vrm-action" :class="{ 'vrm-shining': isExecuting }">{{ isExecuting ? t('chat.vrmLoading') : t('chat.vrmLoaded') }}</span>
      <svg v-if="canExpand" class="vrm-arrow" :class="{ expanded }" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>
    </div>
    <div v-if="expanded && content" class="vrm-content">
      <pre class="vrm-content-body">{{ content }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  /** 工具调用原始参数（含 content/result） */
  args?: string
  result?: string
  status?: string
}>()

const { t } = useI18n({ useScope: 'global' })

const expanded = ref(false)

/** 执行中状态（WorkBuddy isRunningStatus 同款） */
const isExecuting = computed(() => ['idle', 'pending', 'parsing', 'stream_executing', 'full_executing', 'running', 'streaming'].includes(props.status || ''))

/** 完成且有内容 → 可展开 */
const canExpand = computed(() => {
  if (isExecuting.value) return false
  if (['error', 'denied', 'failed', 'cancelled'].includes(props.status || '')) return false
  return !!content.value
})

/** 指南内容：优先 result，其次 args 里的 content */
const content = computed(() => {
  const r = (props.result || '').trim()
  if (r) return r
  if (props.args) {
    try {
      const obj = JSON.parse(props.args)
      if (typeof obj.content === 'string') return obj.content
      if (typeof obj.result === 'string') return obj.result
      if (typeof obj.text === 'string') return obj.text
    } catch {}
  }
  return ''
})

function handleToggle() {
  if (!canExpand.value) return
  expanded.value = !expanded.value
}
</script>

<style scoped>
.vrm-card {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  overflow: hidden;
  margin: 3px 0;
  font-size: var(--text-sm, 13px);
}
.vrm-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  user-select: none;
}
.vrm-header.expandable {
  cursor: pointer;
}
.vrm-header.expandable:hover {
  background: var(--bg-hover, rgba(128, 128, 128, 0.06));
}
.vrm-icon {
  color: var(--accent, var(--text-muted));
  flex-shrink: 0;
}
.vrm-action {
  font-size: 12px;
  color: var(--text-secondary);
  flex: 1;
  min-width: 0;
}
.vrm-shining {
  animation: vrm-shine 1.6s ease-in-out infinite;
}
.vrm-arrow {
  color: var(--text-muted);
  flex-shrink: 0;
  transition: transform 0.2s ease;
}
.vrm-arrow.expanded {
  transform: rotate(180deg);
}
.vrm-content {
  border-top: 1px solid var(--border-color);
  padding: 8px 12px;
  max-height: 300px;
  overflow-y: auto;
}
.vrm-content-body {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}
@keyframes vrm-shine {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
</style>
