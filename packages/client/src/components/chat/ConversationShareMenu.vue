<template>
<Teleport to="body">
      <div v-if="open" class="share-overlay" @click.self="emit('close')">
        <div class="share-menu">
          <button class="share-item" @click="emit('copy')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            {{ $t('chat.shareCopyMd') }}
          </button>
          <button class="share-item" @click="emit('download')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            {{ $t('chat.shareDownloadMd') }}
          </button>
          <button class="share-item" @click="emit('image')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            {{ $t('chat.shareImage') }}
          </button>
        </div>
      </div>
    </Teleport>
</template>

<script setup lang="ts">
defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; copy: []; download: []; image: [] }>()
</script>

<style scoped>
/* ===== Conversation share menu: fixed top-right, shared by the web header and the app top bar ===== */
.share-overlay {
  position: fixed;
  inset: 0;
  z-index: 910;
}
.share-menu {
  position: absolute;
  top: 64px;
  right: 16px;
  width: 208px;
  background: var(--bg-primary);
  border: 0.5px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.14);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.share-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  transition: background var(--duration-fast);
}
.share-item:hover {
  background: var(--bg-hover);
}
.share-item svg {
  color: var(--text-secondary);
  flex-shrink: 0;
}
</style>
