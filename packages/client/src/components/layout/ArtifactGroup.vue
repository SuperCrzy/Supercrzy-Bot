<template>
  <div v-if="artifactFiles.length > 0" class="artifact-group">
    <div class="group-title">{{ $t('detail.sessionArtifacts') }}</div>
    <div class="file-list">
      <div
        v-for="f in artifactFiles"
        :key="f.path"
        class="file-row is-artifact"
        :title="f.path"
        @click="$emit('open', f.path)"
        @contextmenu.prevent="openArtifactMenu($event, f)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span class="file-name">{{ f.name }}</span>
        <span class="file-size" v-if="f.size">{{ formatSize(f.size) }}</span>
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
