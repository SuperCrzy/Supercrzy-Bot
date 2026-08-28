<template>
  <div class="html-preview" :class="{ 'is-updating': updating }">
    <!-- 头部：文件名 + 行数 + 更新状态 + 刷新/打开 -->
    <div v-if="showHeader" class="hp-header">
      <span class="hp-name" :title="path">{{ fileName }}</span>
      <span class="hp-lines">{{ lineCount }} {{ $t('preview.lines') }}</span>
      <span v-if="updating" class="hp-updating">
        <span class="hp-dot" /> {{ $t('preview.updating') }}
      </span>
      <span v-else-if="loaded" class="hp-loaded">{{ $t('preview.live') }}</span>
      <div class="hp-actions">
        <button class="hp-btn" :title="$t('preview.refresh')" @click="reload">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>
        </button>
        <button class="hp-btn" :title="$t('preview.openInTab')" @click="openInTab">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>
      </div>
    </div>
    <!-- iframe 沙箱渲染 -->
    <iframe
      v-if="srcdocContent"
      :srcdoc="srcdocContent"
      class="hp-iframe"
      sandbox="allow-scripts"
      :key="iframeKey"
    />
    <div v-else class="hp-empty">
      {{ $t('preview.empty') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n({ useScope: 'global' })

// ---- props ----
const props = defineProps<{
  content?: string       // 实时预览内容（SSE preview_update）
  path?: string          // 文件名（显示用）
  showHeader?: boolean   // 是否显示头部（DetailPanel 显示 / 工作区可选）
}>()

const updating = ref(false)
const loaded = ref(false)
const iframeKey = ref(0)

const fileName = computed(() => {
  const p = props.path || ''
  return p.split(/[\\/]/).pop() || p
})
const lineCount = computed(() => (props.content || '').split('\n').length)
const srcdocContent = computed(() => props.content || '')

// 内容更新 → 显示"更新中"标记 + 刷新 iframe（防抖由调用方控制，这里只负责渲染）
watch(() => props.content, (v, old) => {
  if (v && v !== old) {
    updating.value = true
    loaded.value = true
    iframeKey.value++  // key 变化强制 iframe 重建
    // 短暂展示更新标记后隐藏
    clearTimeout((watch as any)._t)
    ;(watch as any)._t = setTimeout(() => { updating.value = false }, 1200)
  }
})

function reload() {
  iframeKey.value++
}
function openInTab() {
  if (props.content) {
    const blob = new Blob([props.content], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
}
</script>

<style scoped>
.html-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  position: relative;
}
.hp-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border, #e3e3e6);
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.hp-name {
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40%;
}
.hp-lines { font-size: 10px; color: var(--text-muted); }
.hp-updating {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent, #4f7cff);
}
.hp-dot {
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background: var(--accent, #4f7cff);
  animation: hp-pulse 1s infinite;
}
@keyframes hp-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: .3; }
}
.hp-loaded { color: var(--success, #4caf50); }
.hp-actions { margin-left: auto; display: flex; gap: 2px; }
.hp-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 3px;
  display: flex;
  border-radius: 4px;
}
.hp-btn:hover { background: var(--border, #e3e3e6); color: var(--text-primary); }
.hp-iframe {
  flex: 1;
  border: none;
  width: 100%;
  min-height: 0;
  background: #fff;
}
.hp-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
