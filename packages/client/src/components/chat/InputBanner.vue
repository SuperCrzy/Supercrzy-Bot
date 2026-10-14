<template>
  <!-- 输入横幅（对齐主流实现 cb-input-banner：输入框上方，变体 + 图标 + 消息 + 动作 + 关闭） -->
  <div class="input-banner" :class="`input-banner--${variant}`">
    <button v-if="dismissible" type="button" class="input-banner__close" :title="$t('chat.errorBannerClose')" @click="emit('dismiss')">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
    </button>
    <div class="input-banner__content">
      <div v-if="showIcon" class="input-banner__icon">
        <svg v-if="variant === 'warning'" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <svg v-else width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      </div>
      <div class="input-banner__message">{{ message }}</div>
      <div v-if="actions && actions.length" class="input-banner__actions">
        <button
          v-for="(a, i) in actions"
          :key="i"
          type="button"
          class="input-banner__action"
          :class="`input-banner__action--${a.variant || 'primary'}`"
          @click="a.onClick?.()"
        >{{ a.label }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    message: string
    variant?: 'info' | 'success' | 'warning'
    dismissible?: boolean
    showIcon?: boolean
    actions?: Array<{ label: string; variant?: 'primary' | 'ghost'; onClick?: () => void }>
  }>(),
  {
    variant: 'info',
    dismissible: true,
    showIcon: true,
    actions: () => [],
  },
)

const emit = defineEmits<{ dismiss: [] }>()
</script>

<style scoped>
.input-banner {
  position: relative;
  border-radius: 8px;
  padding: 7px 34px 7px 10px;
  border: 1px solid;
  font-size: 12px;
  margin-bottom: 8px;
  animation: ib-slide-in 0.2s ease-out;
}
@keyframes ib-slide-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
.input-banner--info {
  background: rgba(59, 130, 246, 0.07);
  border-color: rgba(59, 130, 246, 0.3);
}
.input-banner--success {
  background: var(--success-muted, rgba(74, 222, 128, 0.08));
  border-color: rgba(74, 222, 128, 0.35);
}
.input-banner--warning {
  background: var(--warning-muted, rgba(251, 191, 36, 0.08));
  border-color: rgba(251, 191, 36, 0.35);
}
.input-banner__close {
  position: absolute;
  top: 6px;
  right: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
}
.input-banner__close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.input-banner__content {
  display: flex;
  align-items: center;
  gap: 7px;
}
.input-banner__icon {
  display: flex;
  flex-shrink: 0;
  color: #3b82f6;
}
.input-banner--success .input-banner__icon { color: var(--success, #16a34a); }
.input-banner--warning .input-banner__icon { color: var(--warning, #f59e0b); }
.input-banner__message {
  flex: 1;
  color: var(--text-secondary);
  line-height: 1.45;
}
.input-banner__actions {
  display: flex;
  gap: 5px;
  flex-shrink: 0;
}
.input-banner__action {
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 11.5px;
  padding: 2px 9px;
  border-radius: 5px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.input-banner__action:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.input-banner__action--primary {
  background: var(--accent, #4f46e5);
  border-color: var(--accent, #4f46e5);
  color: #fff;
}
.input-banner__action--primary:hover {
  filter: brightness(1.08);
  color: #fff;
}
</style>
