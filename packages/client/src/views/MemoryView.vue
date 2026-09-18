<template>
  <div class="page-container">
    <header class="page-header">
      <h2>{{ $t('memory.title') }}</h2>
      <p class="page-desc">{{ $t('memory.desc') }}</p>
      <div class="header-actions">
        <label class="memory-toggle">
          <span class="memory-toggle-label">{{ $t('settings.memoryEnabled') }}</span>
          <n-switch :value="memoryEnabled" size="small" @update:value="toggleMemoryEnabled" />
        </label>
        <!-- 2026-09-18（#147）：自动整理会合并近似重复并按分类上限淘汰低价值旧记忆（含删除），
             所以必须给用户一个看得见、关得掉的开关，不能只藏在后台静默跑。 -->
        <label class="memory-toggle" :title="$t('settings.memoryAutoConsolidateDesc')">
          <span class="memory-toggle-label">{{ $t('settings.memoryAutoConsolidate') }}</span>
          <n-switch :value="memoryAutoConsolidate" size="small" @update:value="toggleAutoConsolidate" />
        </label>
        <n-input
          v-model:value="searchQuery"
          :placeholder="$t('memory.searchPlaceholder')"
          clearable
          size="small"
          class="search-input"
        >
          <template #prefix>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </template>
        </n-input>
        <n-select
          v-model:value="filterCategory"
          :options="categoryOpts"
          :placeholder="$t('memory.allCategories')"
          size="small"
          clearable
          style="width: 130px"
        />
        <n-button size="small" secondary @click="showImportModal = true" :title="$t('memory.importTitle')">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </template>
          {{ $t('memory.importMemory') }}
        </n-button>
        <n-button size="small" type="primary" @click="showCreateModal = true">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          {{ $t('memory.addMemory') }}
        </n-button>
      </div>
    </header>

    <div class="memory-content">
      <n-spin :show="loading">
        <div class="memory-list" v-if="filteredMemories.length > 0">
          <n-card
            v-for="mem in filteredMemories"
            :key="mem.id"
            size="small"
            class="memory-card"
          >
            <div class="memory-top">
              <div class="memory-key">{{ mem.key }}</div>
              <div class="memory-actions">
                <n-tag size="tiny" :bordered="false" :type="categoryType(mem.category)">
                  {{ categoryLabel(mem.category) }}
                </n-tag>
                <n-rate :value="mem.importance" :count="5" readonly size="small" />
                <n-button size="tiny" quaternary @click="editMemory(mem)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </n-button>
                <n-popconfirm @positive-click="deleteMemory(mem.id)">
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </n-button>
                  </template>
                  {{ $t('memory.deleteConfirm') }}
                </n-popconfirm>
              </div>
            </div>
            <div class="memory-content-text">{{ mem.content }}</div>
            <div class="memory-footer">
              <span class="memory-time">{{ formatTime(mem.updated_at || mem.created_at) }}</span>
            </div>
          </n-card>
        </div>
        <n-empty v-else :description="$t('memory.noMemory')" class="empty-hint" />
      </n-spin>
    </div>

    <!-- Create/Edit Modal -->
    <n-modal v-model:show="showCreateModal" preset="card" :title="$t('memory.detailTitle')" style="max-width: 500px" :mask-closable="false">
      <div class="modal-form">
        <div class="form-group">
          <label>{{ $t('memory.key') }}</label>
          <n-input v-model:value="editForm.key" :placeholder="$t('memory.keyPlaceholder')" />
        </div>
        <div class="form-group">
          <label>{{ $t('memory.content') }}</label>
          <n-input v-model:value="editForm.content" type="textarea" :rows="4" :placeholder="$t('memory.contentPlaceholder')" />
        </div>
        <div class="form-group">
          <label>{{ $t('memory.category') }}</label>
          <n-select v-model:value="editForm.category" :options="categoryOpts.filter(o => o.value !== 'all')" />
        </div>
        <div class="form-group">
          <label>{{ $t('memory.importance') }}</label>
          <n-rate v-model:value="editForm.importance" :count="5" size="medium" />
        </div>
      </div>
      <template #footer>
        <n-button @click="showCreateModal = false">{{ $t('common.cancel') }}</n-button>
        <n-button type="primary" @click="saveMemory" :loading="saving">
          {{ editForm.id ? $t('common.update') : $t('common.create') }}
        </n-button>
      </template>
    </n-modal>

    <!-- 导入对话文件：AI 梳理记忆候选 → 用户确认/编辑 → 批量保存 -->
    <n-modal v-model:show="showImportModal" preset="card" :title="$t('memory.importTitle')" style="max-width: 660px" :mask-closable="false">
      <div class="import-modal">
        <!-- 步骤1：选择文件 -->
        <div v-if="!importFileText && !importing && importCandidates.length === 0" class="import-pick">
          <input ref="importFileInput" type="file" accept=".md,.markdown,.txt" hidden @change="onImportFilePick" />
          <div class="import-drop" @click="importFileInput?.click()" @dragover.prevent @drop.prevent="onImportDrop">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            <p>{{ $t('memory.importPick') }}</p>
            <p class="import-hint">{{ $t('memory.importDesc') }}</p>
          </div>
        </div>

        <!-- 步骤2：AI 梳理中 -->
        <div v-else-if="importing" class="import-analyzing">
          <n-spin size="large" />
          <p>{{ $t('memory.importAnalyzing') }}</p>
        </div>

        <!-- 步骤3：候选确认 -->
        <div v-else-if="importCandidates.length > 0" class="import-candidates">
          <div class="import-cand-head">
            <span>{{ $t('memory.importCandHint') }}</span>
            <n-button size="tiny" quaternary @click="toggleAllImported">
              {{ allImportedChecked ? $t('memory.importUncheckAll') : $t('memory.importCheckAll') }}
            </n-button>
          </div>
          <div v-for="(c, i) in importCandidates" :key="i" class="import-cand" :class="{ dimmed: !c.checked }">
            <div class="cand-row1">
              <n-checkbox v-model:checked="c.checked" />
              <n-input v-model:value="c.key" size="small" :placeholder="$t('memory.keyPlaceholder')" style="flex:1" />
              <n-select v-model:value="c.category" size="small" :options="categoryOpts.filter(o => o.value !== 'all')" style="width:120px" />
              <n-rate v-model:value="c.importance" :count="5" size="small" />
            </div>
            <div class="cand-row2">
              <n-input v-model:value="c.content" type="textarea" :rows="2" :placeholder="$t('memory.contentPlaceholder')" />
            </div>
          </div>
          <div class="import-foot">
            <n-button size="small" @click="resetImport">{{ $t('common.cancel') }}</n-button>
            <n-button size="small" type="primary" :loading="saving" :disabled="checkedImportedCount === 0" @click="saveImported">
              {{ $t('memory.importSave', { count: checkedImportedCount }) }}
            </n-button>
          </div>
        </div>

        <!-- 空结果 -->
        <div v-else class="import-empty">
          <p>{{ $t('memory.importEmpty') }}</p>
          <n-button size="small" @click="resetImport">{{ $t('common.ok') }}</n-button>
        </div>

        <div v-if="importError" class="import-error">{{ importError }}</div>
      </div>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'

interface Memory {
  id: string
  key: string
  content: string
  category: string
  importance: number
  created_at: string
  updated_at: string
}

const nMessage = useMessage()
const { t } = useI18n({ useScope: 'global' })
const memories = ref<Memory[]>([])
const loading = ref(false)
const saving = ref(false)
const searchQuery = ref('')
const filterCategory = ref<string | null>(null)
const showCreateModal = ref(false)

const editForm = ref({
  id: '',
  key: '',
  content: '',
  category: 'general',
  importance: 1,
})

const categoryOpts = [
  { label: t('memory.catAll'), value: 'all' },
  { label: t('memory.categories.general'), value: 'general' },
  { label: t('memory.categories.preference'), value: 'preference' },
  { label: t('memory.categories.fact'), value: 'fact' },
  { label: t('memory.categories.rule'), value: 'rule' },
]

const filteredMemories = computed(() => {
  let list = memories.value
  if (filterCategory.value && filterCategory.value !== 'all') {
    list = list.filter((m) => m.category === filterCategory.value)
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter((m) => m.key.toLowerCase().includes(q) || m.content.toLowerCase().includes(q))
  }
  return list
})

function categoryType(cat: string): 'default' | 'info' | 'success' | 'warning' | 'error' {
  const map: Record<string, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
    general: 'default',
    preference: 'info',
    fact: 'success',
    rule: 'warning',
  }
  return map[cat] || 'default'
}

function categoryLabel(cat: string): string {
  const map: Record<string, string> = {
    general: t('memory.categories.general'),
    preference: t('memory.categories.preference'),
    fact: t('memory.categories.fact'),
    rule: t('memory.categories.rule'),
  }
  return map[cat] || cat
}

function formatTime(d: string): string {
  if (!d) return ''
  const date = new Date(d)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  if (diff < 60000) return t('common.justNow')
  if (diff < 3600000) return `${Math.floor(diff / 60000)}${t('common.minAgo')}`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}${t('common.hourAgo')}`
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ---- 导入对话文件（AI 梳理记忆候选 → 确认/编辑 → 批量保存）----
const showImportModal = ref(false)
const importFileInput = ref<HTMLInputElement | null>(null)
const importFileText = ref('')
const importing = ref(false)
const importError = ref('')
interface ImportCandidate { checked: boolean; key: string; content: string; category: string; importance: number }
const importCandidates = ref<ImportCandidate[]>([])

const checkedImportedCount = computed(() => importCandidates.value.filter((c) => c.checked).length)
const allImportedChecked = computed(() => importCandidates.value.length > 0 && importCandidates.value.every((c) => c.checked))

function onImportFilePick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  readImportFile(file)
}

function onImportDrop(e: DragEvent) {
  const file = e.dataTransfer?.files?.[0]
  if (!file) return
  readImportFile(file)
}

function readImportFile(file: File) {
  const reader = new FileReader()
  reader.onload = async () => {
    importFileText.value = String(reader.result || '')
    await runImport()
  }
  reader.onerror = () => { importError.value = t('memory.importReadFailed') }
  reader.readAsText(file)
}

async function runImport() {
  if (!importFileText.value.trim()) return
  importing.value = true
  importError.value = ''
  importCandidates.value = []
  try {
    const res = await fetch('/api/memory/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: importFileText.value }),
    })
    const data = await res.json()
    if (!res.ok) {
      importError.value = data.error || 'import failed'
    } else {
      importCandidates.value = (data.candidates || []).map((c: any) => ({
        checked: true,
        key: c.key || '',
        content: c.content || '',
        category: c.category || 'general',
        importance: c.importance || 1,
      }))
    }
  } catch (e: any) {
    importError.value = e.message
  } finally {
    importing.value = false
  }
}

function toggleAllImported() {
  const next = !allImportedChecked.value
  importCandidates.value.forEach((c) => { c.checked = next })
}

function resetImport() {
  showImportModal.value = false
  importFileText.value = ''
  importCandidates.value = []
  importError.value = ''
  if (importFileInput.value) importFileInput.value.value = ''
}

async function saveImported() {
  const selected = importCandidates.value.filter((c) => c.checked && c.key.trim() && c.content.trim())
  if (selected.length === 0) {
    nMessage.warning(t('memory.needKeyContent'))
    return
  }
  saving.value = true
  let ok = 0
  for (const c of selected) {
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: c.key.trim(), content: c.content.trim(), category: c.category, importance: c.importance }),
      })
      if (res.ok) ok++
    } catch { /* 单条失败继续 */ }
  }
  saving.value = false
  if (ok > 0) {
    nMessage.success(t('memory.importSaved', { count: ok }))
    resetImport()
    await fetchMemories()
  } else {
    nMessage.error(t('memory.importSaveFailed'))
  }
}

async function fetchMemories() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (filterCategory.value && filterCategory.value !== 'all') {
      params.set('category', filterCategory.value)
    }
    if (searchQuery.value.trim()) {
      params.set('search', searchQuery.value.trim())
    }
    const qs = params.toString()
    const res = await fetch(`/api/memory${qs ? '?' + qs : ''}`)
    if (res.ok) {
      memories.value = await res.json()
    }
  } catch (err: any) {
    nMessage.error(t('memory.loadFail'))
  } finally {
    loading.value = false
  }
}

function editMemory(mem: Memory) {
  editForm.value = {
    id: mem.id,
    key: mem.key,
    content: mem.content,
    category: mem.category,
    importance: mem.importance,
  }
  showCreateModal.value = true
}

async function saveMemory() {
  if (!editForm.value.key.trim() || !editForm.value.content.trim()) {
    nMessage.warning(t('memory.needKeyContent'))
    return
  }
  saving.value = true
  try {
    const isUpdate = !!editForm.value.id
    const url = isUpdate ? `/api/memory/${editForm.value.id}` : '/api/memory'
    const method = isUpdate ? 'PUT' : 'POST'
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: editForm.value.key,
        content: editForm.value.content,
        category: editForm.value.category,
        importance: editForm.value.importance,
      }),
    })
    if (res.ok) {
      nMessage.success(isUpdate ? t('memory.updated') : t('memory.created'))
      showCreateModal.value = false
      editForm.value = { id: '', key: '', content: '', category: 'general', importance: 1 }
      await fetchMemories()
    }
  } catch {
    nMessage.error(t('memory.saveFail'))
  } finally {
    saving.value = false
  }
}

async function deleteMemory(id: string) {
  try {
    const res = await fetch(`/api/memory/${id}`, { method: 'DELETE' })
    if (res.ok) {
      nMessage.success(t('memory.deleted'))
      memories.value = memories.value.filter((m) => m.id !== id)
    }
  } catch {
    nMessage.error(t('memory.deleteFail'))
  }
}

onMounted(() => {
  fetchMemories()
  // 记忆开关（原在设置页"记忆" tab，已合并到本页统一管理）
  fetch('/api/settings')
    .then((r) => r.json())
    .then((d) => {
      if (d.memoryEnabled !== undefined) memoryEnabled.value = !!d.memoryEnabled
      if (d.memoryAutoConsolidate !== undefined) memoryAutoConsolidate.value = !!d.memoryAutoConsolidate
    })
    .catch(() => {})
})

// 记忆开关：切换即保存到后端设置
const memoryEnabled = ref(true)
async function toggleMemoryEnabled(v: boolean) {
  memoryEnabled.value = v
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryEnabled: v }),
    })
  } catch (err) {
    console.error('Failed to save memoryEnabled:', err)
  }
}

// 自动整理开关（默认开）：关掉后后台不再合并/淘汰记忆，仍可用 AI 显式调用整理
const memoryAutoConsolidate = ref(true)
async function toggleAutoConsolidate(v: boolean) {
  memoryAutoConsolidate.value = v
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryAutoConsolidate: v }),
    })
  } catch (err) {
    console.error('Failed to save memoryAutoConsolidate:', err)
  }
}
</script>

<style scoped>
.page-container {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.page-header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.page-header h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}
.page-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin: 4px 0 12px;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.memory-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.memory-toggle-label {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}
.search-input {
  width: 220px;
}

.memory-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
}

.memory-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.memory-card {
  border: 1px solid var(--border-color);
}
.memory-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.memory-key {
  font-size: 14px;
  font-weight: 600;
}
.memory-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.memory-content-text {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: 8px;
}
.memory-footer {
  font-size: 11px;
  color: var(--text-muted);
}
.memory-time {
  font-size: 11px;
}

.empty-hint {
  margin-top: 60px;
}

/* Modal form */
.modal-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

/* ---- 导入对话文件（AI 梳理记忆候选） ---- */
.import-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.import-pick .import-drop {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 36px 20px;
  border: 1.5px dashed var(--border-color);
  border-radius: 10px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: border-color 0.2s, color 0.2s;
}
.import-pick .import-drop:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.import-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
  text-align: center;
}
.import-analyzing {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 0;
  color: var(--text-secondary);
}
.import-candidates {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 52vh;
  overflow-y: auto;
}
.import-cand-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-secondary);
}
.import-cand {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-tertiary);
}
.import-cand.dimmed {
  opacity: 0.45;
}
.cand-row1 {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cand-row2 {
  padding-left: 22px;
}
.import-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 4px;
}
.import-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 30px 0;
  color: var(--text-secondary);
}
.import-error {
  color: var(--error);
  font-size: 12px;
  padding: 4px 0;
}
</style>
