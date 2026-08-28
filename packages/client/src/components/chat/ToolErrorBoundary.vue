<template>
  <div v-if="hasError" class="tool-error-boundary" role="alert">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    <span class="teb-text">{{ $t('chatui.toolRenderError') }}</span>
    <code class="teb-name">{{ toolName }}</code>
  </div>
  <slot v-else />
</template>

<script setup lang="ts">
import { ref, onErrorCaptured } from 'vue'

/**
 * 工具卡片错误边界（WorkBuddy ToolRendererErrorBoundary 同款）：
 * 单张卡片渲染异常（坏 result / 组件 bug）只降级为占位卡片，不炸掉整条消息。
 */
const props = defineProps<{ toolName?: string }>()

const hasError = ref(false)
onErrorCaptured((err) => {
  hasError.value = true
  console.error('[ToolErrorBoundary]', props.toolName, err)
  return false // 阻止继续向上传播
})
</script>

<style scoped>
.tool-error-boundary {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0;
  padding: 8px 10px;
  border-radius: var(--radius-md, 8px);
  border: 1px dashed var(--warning, #d97706);
  background: color-mix(in srgb, var(--warning, #d97706) 6%, transparent);
  font-size: 12px;
  color: var(--text-secondary, #666);
}
.teb-text { flex-shrink: 0; }
.teb-name {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-muted, #999);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
