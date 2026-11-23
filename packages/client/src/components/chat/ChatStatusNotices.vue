<template>
  <div v-if="sending" class="notice" role="status">{{ $t('chat.sendingMessage') }}</div>
  <div v-if="unsaved" class="notice" role="alert">{{ $t('chat.messageSaveFailed') }} <button type="button" @click="$emit('retrySave')">{{ $t('common.refresh') }}</button></div>
  <div v-if="historyState" class="notice" role="status">{{ $t(historyState === 'loading' ? 'chat.historyLoading' : 'chat.historyLoadFailed') }} <button v-if="historyState === 'error'" type="button" @click="$emit('retryHistory')">{{ $t('common.refresh') }}</button></div>
</template>
<script setup lang="ts">
defineProps<{ sending: boolean; unsaved: boolean; historyState?: 'loading' | 'error' }>()
defineEmits<{ retrySave: []; retryHistory: [] }>()
</script>
<style scoped>
.notice { margin: 12px auto; padding: 10px 12px; max-width: 720px; border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-secondary); background: var(--bg-secondary); font-size: 13px; }
.notice button { margin-left: 8px; border: 0; background: transparent; color: var(--accent); cursor: pointer; }
</style>
