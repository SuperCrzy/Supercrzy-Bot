<template>
  <div v-if="items.length" class="pending-queue">
    <div class="pending-queue-head">
      <span class="pending-queue-title">{{ $t('chat.pendingQueueTitle') }} ({{ items.length }})</span>
      <span class="pending-queue-hint">{{ $t(loading ? 'chat.pendingQueueHint' : 'chat.queuePausedHint') }}</span>
      <button v-if="!loading" class="queue-send" type="button" @click="$emit('send')">{{ $t('chat.sendQueuedNow') }}</button>
    </div>
    <div v-for="item in items" :key="item.id" class="pending-queue-item">
      <span class="pending-queue-text" :title="item.text">{{ item.text }}</span>
      <button class="queue-action" type="button" :aria-label="$t('chat.editQueued')" :title="$t('chat.editQueued')" @click="$emit('edit', item.id)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
      </button>
      <button class="queue-action queue-delete" type="button" :aria-label="$t('common.delete')" :title="$t('common.delete')" @click="$emit('remove', item.id)">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { PendingQueueItem } from '@/composables/useSessionQueue'
defineProps<{ items: PendingQueueItem[]; loading: boolean }>()
defineEmits<{ edit: [id: string]; remove: [id: string]; send: [] }>()
</script>

<style scoped>
.pending-queue {
  margin-bottom: 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pending-queue-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}
.pending-queue-title {
  font-weight: 600;
  color: var(--accent);
}
.pending-queue-hint {
  color: var(--text-muted);
}
.pending-queue-item {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 5px 8px;
}
.pending-queue-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.queue-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;
  transition: color var(--duration-fast), background var(--duration-fast);
}
.queue-action:hover {
  background: var(--bg-hover);
  color: var(--accent);
}
.queue-action.queue-delete:hover {
  color: var(--error);
  background: var(--error-muted);
}

.pending-queue-head { flex-wrap: wrap; }
.queue-send { border: 0; background: transparent; color: var(--accent); cursor: pointer; padding: 4px; font-size: 11px; }
.queue-send:focus-visible { outline: 2px solid var(--accent); }
</style>
