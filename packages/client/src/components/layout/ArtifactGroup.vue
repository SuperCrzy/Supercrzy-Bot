<template>
  <div v-if="artifactFiles.length > 0 || loadError" class="artifact-group">
    <div class="group-title">{{ $t('detail.sessionArtifacts') }}</div>
    <div v-if="loadError" class="artifact-error" role="status">
      <span>{{ $t('detail.artifactLoadError') }}</span>
      <button type="button" @click="loadSessionArtifacts">{{ $t('common.refresh') }}</button>
    </div>
    <div class="file-list">
      <div
        v-for="f in artifactFiles"
        :key="f.path"
        class="file-row is-artifact"
        :title="f.path"
        @contextmenu.prevent="openArtifactMenu($event, f)"
      >
        <button class="artifact-open" type="button" @click="$emit('open', f.path)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span class="file-name">{{ f.name }}</span>
        <span class="file-size" v-if="f.size">{{ formatSize(f.size) }}</span>
        </button>
        <button class="artifact-actions" type="button" :aria-label="$t('detail.artifactActions', { name: f.name })" @click.stop="openArtifactMenu($event, f)">⋯</button>
      </div>
    </div>

    <div
      v-if="artifactMenu.open"
      class="artifact-menu"
      :style="{ left: artifactMenu.x + 'px', top: artifactMenu.y + 'px' }"
      @click.stop
    >
      <button class="artifact-menu-item" type="button" @click="menuPreviewArtifact">{{ $t('detail.menuPreview') }}</button>
      <button class="artifact-menu-item" type="button" @click="menuRevealArtifact">{{ $t('detail.menuReveal') }}</button>
      <button class="artifact-menu-item" type="button" @click="menuCopyPath">{{ $t('detail.menuCopyPath') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * "本次会话产物" group for the right panel.
 *
 * Self-contained on purpose: DetailPanel.vue has a hard line budget, and this
 * group needs its own state (list, context menu) plus two data sources.
 */
import { useChatStore } from '@/stores/chat'
import { useSessionArtifacts } from '@/composables/useSessionArtifacts'
import { formatSize } from '@/utils/format-size'

const props = defineProps<{
  visible: boolean
  activeTab: string
}>()

const emit = defineEmits<{
  (e: 'open', path: string): void
  (e: 'open-dir', path: string): void
}>()

const chatStore = useChatStore()

const {
  artifactFiles,
  artifactMenu,
  loadError,
  loadSessionArtifacts,
  openArtifactMenu,
  menuPreviewArtifact,
  menuRevealArtifact,
  menuCopyPath,
} = useSessionArtifacts({
  sessionId: () => chatStore.currentSessionId,
  visible: () => props.visible,
  activeTab: () => props.activeTab,
  messages: () => chatStore.currentMessages,
  preview: (path: string) => emit('open', path),
  openDir: (path: string) => emit('open-dir', path),
})
</script>

<style scoped>
.group-title {
  padding: 8px 12px 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.file-row.is-artifact { color: var(--accent, #4f7cff); }
.file-row.is-artifact .file-name { font-weight: 500; }
.file-list { display: flex; flex-direction: column; gap: 2px; }
.file-row { display: flex; align-items: center; border-radius: var(--radius-sm); }
.file-row:hover, .file-row:focus-within { background: var(--bg-hover); }
.artifact-open { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1; padding: 5px 8px; border: 0; background: transparent; color: inherit; font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.artifact-open svg { flex: none; }
.file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-size { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.artifact-actions { border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-secondary); padding: 4px 8px; cursor: pointer; font-size: 16px; }
.artifact-actions:hover, .artifact-actions:focus-visible { background: var(--bg-hover); color: var(--text-primary); }
.artifact-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 12px; color: var(--text-secondary); font-size: 12px; }
.artifact-error button { flex: none; color: var(--accent, #4f7cff); background: transparent; border: 0; cursor: pointer; }
.artifact-menu {
  position: fixed;
  z-index: 4000;
  min-width: 176px;
  padding: 4px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
}
.artifact-menu-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  text-align: left;
  border-radius: 5px;
  cursor: pointer;
}
.artifact-menu-item:hover { background: var(--bg-hover); }
</style>
