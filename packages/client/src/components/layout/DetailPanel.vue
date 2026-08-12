<template>
  <aside class="detail-panel" :class="{ visible }">
    <!-- Tab 头部 -->
    <div class="panel-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="panel-tab"
        :class="{ active: activeTab === tab.key }"
        @click="switchTab(tab.key)"
      >
        <div class="tab-icon" v-html="tab.icon"></div>
        <span class="tab-label">{{ tab.label }}</span>
      </button>

      <button class="panel-close-btn" @click="emit('toggle')" title="收起面板">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
    </div>

    <!-- Tab 内容区 -->
    <div class="panel-body">
      <!-- 产物 Tab -->
      <div v-if="activeTab === 'artifacts'" class="tab-content">
        <div class="tab-hint">当前会话产生的交付文件</div>
        <div v-if="artifactFiles.length === 0" class="tab-empty">
          <n-empty description="暂无产物" />
        </div>
        <div v-else class="file-list">
          <div
            v-for="f in artifactFiles"
            :key="f.path"
            class="file-row"
            @click="loadAndPreviewFile(f.path)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="file-name">{{ f.name }}</span>
            <span class="file-path">{{ f.path }}</span>
            <span v-if="f.size" class="file-size">{{ formatSize(f.size) }}</span>
          </div>
        </div>
      </div>

      <!-- 文件 Tab — 工作区文件树 -->
      <div v-if="activeTab === 'files'" class="tab-content">
        <div class="tab-hint">当前目录: {{ currentDir || '/' }}</div>
        <button class="refresh-btn" @click="() => loadFiles()" :disabled="loadingFiles">刷新</button>
        <div v-if="loadingFiles" class="loading-hint">加载中...</div>
        <div v-else-if="fileTree.length === 0" class="tab-empty">
          <n-empty description="暂无文件" />
        </div>
        <div v-else class="file-list">
          <div
            v-for="f in fileTree"
            :key="f.path"
            class="file-row"
            @click="f.type === 'directory' ? navigateDir(f.path) : loadAndPreviewFile(f.path)"
          >
            <svg v-if="f.type === 'directory'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="file-name">{{ f.name }}</span>
            <span v-if="f.type === 'directory'" class="file-type-dir">目录</span>
            <span v-if="f.size" class="file-size">{{ formatSize(f.size) }}</span>
          </div>
        </div>
      </div>

      <!-- 变更 Tab -->
      <div v-if="activeTab === 'changes'" class="tab-content">
        <div class="tab-hint">文件变更记录</div>
        <div v-if="diffFiles.length === 0">
          <n-empty description="暂无变更" />
        </div>
        <div v-else class="diff-list">
          <div v-for="(df, i) in diffFiles" :key="i" class="diff-item" @click="selectedDiff = i; showDiff()">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/></svg>
            <span class="diff-filename">{{ df.name }}</span>
          </div>
        </div>
        <div v-if="showDiffEditor" class="diff-editor-container" ref="diffEditorRef"></div>
      </div>

      <!-- 预览 Tab -->
      <div v-if="activeTab === 'preview'" class="tab-content">
        <div v-if="previewFileName" class="mobile-tip">
          <div class="qr-section" v-if="previewUrl || previewFileName">
            <div class="qr-label">📱 手机扫码预览</div>
            <img
              :src="qrCodeURL"
              class="qr-code"
              alt="Scan to preview on phone"
            />
            <div class="qr-url">{{ mobilePreviewURL }}</div>
          </div>
        </div>
        <div class="tab-hint">文件内容预览</div>
        <div v-if="!previewContent && !previewUrl" class="tab-empty">
          <n-empty description="选中文件即可预览" />
        </div>
        <div v-else-if="previewContent" class="preview-content">
          <div class="preview-header">{{ previewFileName }}</div>
          <pre class="preview-code"><code>{{ previewContent }}</code></pre>
        </div>
        <div v-else-if="previewHtml" class="preview-content">
          <div class="preview-header">HTML 预览</div>
          <iframe :srcdoc="previewHtml" class="preview-iframe" sandbox="allow-scripts"></iframe>
        </div>
        <div v-else-if="previewUrl" class="preview-content">
          <iframe :src="previewUrl" class="preview-iframe"></iframe>
        </div>
      </div>

      <!-- 时间线 Tab -->
      <div v-if="activeTab === 'timeline'" class="tab-content">
        <TimelinePanel :flow="lastAssistantFlow" />
      </div>

      <!-- 幽灵 Tab -->
      <div v-if="activeTab === 'ghost'" class="tab-content">
        <GhostPanel />
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue'
import { NEmpty } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { useChatStore } from '@/stores/chat'
import { extractFiles } from '@/types'
import type { ChatFlowNode } from '@/types'
import TimelinePanel from '@/components/chat/TimelinePanel.vue'
import GhostPanel from '@/components/chat/GhostPanel.vue'
import type { FileBlock } from '@/types'
import * as monaco from 'monaco-editor'

interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
}

const props = defineProps<{
  visible: boolean
  activeTab: 'artifacts' | 'files' | 'changes' | 'preview' | 'timeline' | 'ghost'
}>()

const emit = defineEmits<{
  (e: 'toggle'): void
  (e: 'update:tab', tab: 'artifacts' | 'files' | 'changes' | 'preview' | 'timeline' | 'ghost'): void
}>()

const appStore = useAppStore()
const chatStore = useChatStore()

/** 当前会话最后一条 assistant 消息的时序流（时间线数据源） */
const lastAssistantFlow = computed<ChatFlowNode[] | undefined>(() => {
  const msgs = chatStore.currentMessages
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant' && m.flow && m.flow.length) {
      return m.flow
    }
  }
  return undefined
})

// ----- Artifacts -----
const artifactFiles = computed<FileBlock[]>(() => {
  const msgs = chatStore.currentMessages
  const files: FileBlock[] = []
  for (const m of msgs) {
    if (m.role === 'assistant') {
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === 'file') files.push(b as FileBlock)
      }
    }
  }
  return files
})

// ----- File Tree -----
const fileTree = ref<FileEntry[]>([])
const currentDir = ref('')
const loadingFiles = ref(false)

async function loadFiles(dir?: string) {
  loadingFiles.value = true
  try {
    const url = dir ? `/api/workspace/files?dir=${encodeURIComponent(dir)}` : '/api/workspace/files'
    const res = await fetch(url)
    if (res.ok) {
      const data = await res.json()
      fileTree.value = data.files || []
      currentDir.value = data.path || ''
    }
  } catch (e) {
    console.error('Failed to load workspace files:', e)
  } finally {
    loadingFiles.value = false
  }
}

function navigateDir(path: string) {
  loadFiles(path)
}

// Auto-load files when tab switches to 'files'
watch(() => ({ visible: true, tab: null }), () => {
  // handled by parent
})

// ----- Preview -----
const previewContent = ref('')
const previewUrl = ref('')
const previewHtml = ref('')
const previewFileName = ref('')

// 手机扫码预览：本地模式用当前 origin 生成预览链接，二维码由 server /api/qrcode 生成
const mobilePreviewURL = computed(() =>
  previewFileName.value
    ? `${window.location.origin}/api/preview/${encodeURIComponent(previewFileName.value)}`
    : ''
)
const qrCodeURL = computed(() =>
  mobilePreviewURL.value
    ? `/api/qrcode?text=${encodeURIComponent(mobilePreviewURL.value)}`
    : ''
)
const diffFiles = ref<Array<{ name: string; path: string; oldContent?: string; newContent?: string }>>([])
const selectedDiff = ref(0)
const showDiffEditor = ref(false)
const diffEditorRef = ref<HTMLElement | null>(null)
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null

// 从 tool-call 收集中提取文件变更
watch([() => chatStore.currentMessages, () => props.visible], () => {
  const files: typeof diffFiles.value = []
  for (const m of chatStore.currentMessages) {
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'tool-call' && b.name === 'file_write') {
        try {
          const args = JSON.parse(b.args || '{}')
          files.push({ name: args.path?.split('/').pop() || 'file', path: args.path || '', newContent: args.content, oldContent: args.old_str })
        } catch { files.push({ name: 'file', path: '', newContent: b.args?.slice(0, 500) }) }
      }
    }
  }
  diffFiles.value = files
})

function showDiff() {
  showDiffEditor.value = true
  nextTick(() => {
    if (diffEditorRef.value) {
      if (diffEditor) diffEditor.dispose()
      const df = diffFiles.value[selectedDiff.value]
      diffEditor = monaco.editor.createDiffEditor(diffEditorRef.value, {
        theme: 'vs-dark', readOnly: true, automaticLayout: true,
        fontSize: 12, minimap: { enabled: false },
      })
      diffEditor.setModel({
        original: monaco.editor.createModel(df?.oldContent || '', 'text/plain'),
        modified: monaco.editor.createModel(df?.newContent || '', 'text/plain'),
      })
    }
  })
}

async function loadAndPreviewFile(filePath: string) {
  try {
    const res = await fetch(`/api/workspace/files/content?path=${encodeURIComponent(filePath)}`)
    if (res.ok) {
      const data = await res.json()
      const content = data.content.substring(0, 100000)
      previewFileName.value = filePath
      previewUrl.value = ''
      previewContent.value = ''
      previewHtml.value = ''

      // HTML 文件 → iframe 预览
      if (filePath.endsWith('.html') || filePath.endsWith('.htm')) {
        previewHtml.value = content
      } else {
        previewContent.value = content
      }
      // switch to preview tab
      emit('update:tab', 'preview')
    }
  } catch (e) {
    console.error('Failed to load file:', e)
  }
}

// Load files when panel becomes visible
watch(() => ({ visible: true }), () => {
  // no-op for now
})

// 监听外部触发的文件预览请求（从 ChatView 点击文件产出）
watch(() => appStore.previewFilePath, (path) => {
  if (path) {
    loadAndPreviewFile(path)
    appStore.previewFilePath = ''  // 消费后清空
  }
})

function switchTab(tab: 'artifacts' | 'files' | 'changes' | 'preview' | 'timeline' | 'ghost') {
  emit('update:tab', tab)
  if (tab === 'files' && fileTree.value.length === 0) {
    loadFiles()
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const tabs = [
  { key: 'artifacts' as const, label: '产物', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' },
  { key: 'files' as const, label: '文件', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' },
  { key: 'changes' as const, label: '变更', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>' },
  { key: 'preview' as const, label: '预览', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>' },
  { key: 'timeline' as const, label: '时间线', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17h18M3 12h18M3 7h18"/><circle cx="12" cy="17" r="1.5" fill="currentColor"/><circle cx="7" cy="12" r="1.5" fill="currentColor"/><circle cx="16" cy="7" r="1.5" fill="currentColor"/></svg>' },
  { key: 'ghost' as const, label: '幽灵', icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a7 7 0 0 0-7 7v7h14v-7a7 7 0 0 0-7-7z"/><path d="M8 14h.01M16 14h.01M8 18v3M16 18v3"/></svg>' },
]
</script>

<style scoped>
.detail-panel {
  width: 0;
  min-width: 0;
  background: var(--bg-sidebar);
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width var(--duration-normal) var(--ease-out),
              min-width var(--duration-normal) var(--ease-out),
              opacity var(--duration-fast) var(--ease-out);
  opacity: 0;
}

.detail-panel.visible {
  width: 320px;
  min-width: 320px;
  opacity: 1;
}

.panel-tabs {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border-color);
  padding: 0 6px;
  gap: 2px;
  flex-shrink: 0;
}

.panel-tab {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--text-muted);
  background: none;
  border: none;
  border-radius: 4px 4px 0 0;
  cursor: pointer;
  white-space: nowrap;
}

.panel-tab:hover { color: var(--text-secondary); background: var(--bg-hover); }
.panel-tab.active { color: var(--accent); border-bottom: 2px solid var(--accent); margin-bottom: -1px; }

.tab-icon { display: flex; align-items: center; flex-shrink: 0; }
.tab-label { font-weight: 500; }

.panel-close-btn {
  margin-left: auto;
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: var(--radius-sm);
  border: none; background: transparent; cursor: pointer; color: var(--text-muted);
}
.panel-close-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

.panel-body { flex: 1; overflow-y: auto; padding: 8px; }
.tab-content { display: flex; flex-direction: column; gap: 8px; }
.tab-hint { font-size: 11px; color: var(--text-muted); line-height: 1.4; }
.tab-empty { margin-top: 24px; }

/* File list */
.file-list { display: flex; flex-direction: column; gap: 2px; }
.file-row {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border-radius: var(--radius-sm);
  cursor: pointer; font-size: 12px;
  transition: background var(--duration-fast);
}
.file-row:hover { background: var(--bg-hover); }
.file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-path { font-size: 10px; color: var(--text-muted); max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.file-size { font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.file-type-dir { font-size: 10px; color: #eab308; }

.refresh-btn {
  font-size: 11px; padding: 2px 8px; border-radius: var(--radius-sm);
  border: 1px solid var(--border-color); background: transparent;
  cursor: pointer; color: var(--text-secondary);
}
.refresh-btn:hover { background: var(--bg-hover); }

.loading-hint { font-size: 11px; color: var(--text-muted); text-align: center; }

/* Preview */
.preview-header { font-size: 11px; color: var(--text-muted); padding: 4px 0; border-bottom: 1px solid var(--border-color); margin-bottom: 4px; }
.preview-code { font-family: var(--font-mono); font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-x: auto; max-height: 100%; padding: 8px; background: var(--bg-primary); border-radius: var(--radius-sm); color: var(--text-primary); }
.preview-iframe { width: 100%; min-height: 400px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); }

/* Diff */
.diff-list { display: flex; flex-direction: column; gap: 2px; }
.diff-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; font-size: 12px; border-radius: var(--radius-sm); cursor: pointer; }
.diff-item:hover { background: var(--bg-hover); }
.diff-filename { font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diff-editor-container { margin-top: 8px; height: 350px; border: 1px solid var(--border-color); border-radius: var(--radius-md); overflow: hidden; }
</style>
