<template>
  <div class="page-container"><header class="page-header"><h2>工作区文件</h2><p class="page-desc">浏览和管理 SuperCrzy 工作区文件</p></header>
    <div class="file-browser">
      <div class="breadcrumb"><span v-for="(p,i) in pathParts" :key="i" class="breadcrumb-item" @click="navigateTo(i)">{{ p || '根目录' }}</span></div>
      <div class="file-list">
        <div v-for="f in files" :key="f.name" class="file-item" @click="f.isDir ? enterDir(f.name) : null">
          <span class="file-icon">{{ f.isDir ? '📁' : fileIcon(f.name) }}</span>
          <span class="file-name">{{ f.name }}</span>
          <span class="file-size">{{ formatSize(f.size) }}</span>
          <span class="file-time">{{ formatTime(f.mtime) }}</span>
        </div>
        <n-empty v-if="files.length === 0" description="空目录" class="empty-state" />
      </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
const currentPath = ref('')
const files = ref<any[]>([])
const pathParts = computed(() => currentPath.value.split('/').filter(Boolean))
function fileIcon(name: string) { const ext = name.split('.').pop()?.toLowerCase(); const icons: Record<string, string> = { vue: '💚', ts: '🔷', js: '🟨', json: '📋', md: '📝', css: '🎨', html: '🌐', py: '🐍', yml: '⚙️', yaml: '⚙️', sql: '🗄️', sh: '⚡' }; return icons[ext || ''] || '📄' }
function formatSize(bytes: number) { if (!bytes) return '--'; if (bytes < 1024) return bytes + ' B'; if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB'; return (bytes / 1048576).toFixed(1) + ' MB' }
function formatTime(d: string) { return new Date(d).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function enterDir(name: string) { currentPath.value = currentPath.value ? `${currentPath.value}/${name}` : name; loadFiles() }
function navigateTo(idx: number) { currentPath.value = pathParts.value.slice(0, idx).join('/'); loadFiles() }
onMounted(loadFiles)
async function loadFiles() { try { const res = await fetch(`/api/workspace/files${currentPath.value ? `?dir=${encodeURIComponent(currentPath.value)}` : ''}`); if (res.ok) { const data = await res.json(); files.value = (data.files || []).map((f: any) => ({ ...f, isDir: f.type === 'directory' })) } } catch {} }
</script>
<style scoped>
.page-container { height: 100vh; display: flex; flex-direction: column; }
.page-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color); }
.page-header h2 { font-size: 16px; font-weight: 600; margin: 0; } .page-desc { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }
.file-browser { flex: 1; overflow-y: auto; padding: 16px 24px; }
.breadcrumb { display: flex; gap: 6px; align-items: center; font-size: 13px; margin-bottom: 16px; color: var(--text-muted); }
.breadcrumb-item { cursor: pointer; padding: 2px 6px; border-radius: 4px; }
.breadcrumb-item:hover { background: var(--bg-secondary); color: var(--accent); }
.breadcrumb-item::after { content: '/'; margin-left: 6px; color: var(--text-muted); }
.breadcrumb-item:last-child::after { content: ''; }
.file-item { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 8px; cursor: pointer; transition: background 0.15s; font-size: 13px; }
.file-item:hover { background: var(--bg-secondary); }
.file-icon { font-size: 16px; flex-shrink: 0; }
.file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-size { font-size: 11px; color: var(--text-muted); width: 70px; text-align: right; }
.file-time { font-size: 11px; color: var(--text-muted); width: 140px; text-align: right; }
.empty-state { margin-top: 40px; }
</style>
