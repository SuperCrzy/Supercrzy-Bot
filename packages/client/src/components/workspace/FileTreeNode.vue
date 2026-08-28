<template>
  <div class="ftn">
    <div
      class="file-item"
      :class="{ directory: node.isDirectory, expanded: node.expanded, dirty: dirty }"
      :style="{ paddingLeft: depth * 14 + 6 + 'px' }"
      @click="node.isDirectory ? toggle() : open()"
      @contextmenu.prevent="$emit('ctx', $event, node)"
    >
      <span v-if="node.isDirectory" class="ftn-arrow">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :style="{ transform: node.expanded ? 'rotate(90deg)' : '' }"><polyline points="9 18 15 12 9 6"/></svg>
      </span>
      <span v-else class="ftn-arrow" />
      <span class="file-icon">
        <svg v-if="node.isDirectory" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      </span>
      <span class="file-name">{{ node.name }}</span>
      <span v-if="dirty" class="dirty-dot" :title="'Git 已修改'" />
      <span class="file-size" v-if="!node.isDirectory">{{ formatSize(node.size) }}</span>
    </div>
    <div v-if="node.isDirectory && node.expanded" class="ftn-children">
      <FileTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :dirty-set="dirtySet"
        @toggle="toggleChild"
        @open="$emit('open', $event)"
        @ctx="(ev: MouseEvent, n: TreeNode) => $emit('ctx', ev, n)"
      />
      <div v-if="node.children && node.children.length === 0" class="ftn-empty" :style="{ paddingLeft: depth * 14 + 24 + 'px' }">（空目录）</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

export interface TreeNode {
  name: string
  isDirectory: boolean
  size: number
  path: string
  mtime?: string
  children?: TreeNode[]
  expanded?: boolean
}

const props = defineProps<{
  node: TreeNode
  depth: number
  dirtySet?: Set<string>
}>()

const emit = defineEmits<{
  (e: 'toggle', node: TreeNode): void
  (e: 'open', path: string): void
  (e: 'ctx', ev: MouseEvent, node: TreeNode): void
}>()

const dirty = computed(() => {
  if (!props.dirtySet) return false
  return props.dirtySet.has(props.node.path)
})

function toggle() {
  emit('toggle', props.node)
}

function open() {
  emit('open', props.node.path)
}

function toggleChild(node: TreeNode) {
  emit('toggle', node)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
</script>

<style scoped>
.ftn { user-select: none; }
.file-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
}
.file-item:hover { background: var(--bg-hover); }
.file-item.dirty .file-name { color: #eab308; }
.ftn-arrow {
  width: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform .15s;
}
.file-icon { display: inline-flex; align-items: center; flex-shrink: 0; }
.file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-size { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
.dirty-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #eab308; flex-shrink: 0;
}
.ftn-empty { font-size: 11px; color: var(--text-muted); padding: 3px 0; }
</style>
