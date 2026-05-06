<template>
  <div class="page-container">
    <header class="page-header">
      <h2>记忆管理</h2>
      <p class="page-desc">管理智能体的长期记忆。智能体会自动从对话中学习并存储重要信息。</p>
      <div class="header-actions">
        <n-input
          v-model:value="searchQuery"
          placeholder="搜索记忆..."
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
          placeholder="全部分类"
          size="small"
          clearable
          style="width: 130px"
        />
        <n-button size="small" type="primary" @click="showCreateModal = true">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          添加记忆
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
                  确定删除这条记忆？
                </n-popconfirm>
              </div>
            </div>
            <div class="memory-content-text">{{ mem.content }}</div>
            <div class="memory-footer">
              <span class="memory-time">{{ formatTime(mem.updated_at || mem.created_at) }}</span>
            </div>
          </n-card>
        </div>
        <n-empty v-else description="暂无记忆" class="empty-hint" />
      </n-spin>
    </div>

    <!-- Create/Edit Modal -->
    <n-modal v-model:show="showCreateModal" preset="card" title="记忆详情" style="max-width: 500px" :mask-closable="false">
      <div class="modal-form">
        <div class="form-group">
          <label>标识（key）</label>
          <n-input v-model:value="editForm.key" placeholder="例如：用户偏好、项目名称" />
        </div>
        <div class="form-group">
          <label>内容</label>
          <n-input v-model:value="editForm.content" type="textarea" :rows="4" placeholder="记忆的具体内容..." />
        </div>
        <div class="form-group">
          <label>分类</label>
          <n-select v-model:value="editForm.category" :options="categoryOpts.filter(o => o.value !== 'all')" />
        </div>
        <div class="form-group">
          <label>重要性</label>
          <n-rate v-model:value="editForm.importance" :count="5" size="medium" />
        </div>
      </div>
      <template #footer>
        <n-button @click="showCreateModal = false">取消</n-button>
        <n-button type="primary" @click="saveMemory" :loading="saving">
          {{ editForm.id ? '更新' : '创建' }}
        </n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useMessage } from 'naive-ui'

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
  { label: '全部', value: 'all' },
  { label: '通用', value: 'general' },
  { label: '偏好', value: 'preference' },
  { label: '事实', value: 'fact' },
  { label: '规则', value: 'rule' },
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
    general: '通用',
    preference: '偏好',
    fact: '事实',
    rule: '规则',
  }
  return map[cat] || cat
}

function formatTime(d: string): string {
  if (!d) return ''
  const date = new Date(d)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m 前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h 前`
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
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
    nMessage.error('加载记忆失败')
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
    nMessage.warning('请填写标识和内容')
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
      nMessage.success(isUpdate ? '记忆已更新' : '记忆已创建')
      showCreateModal.value = false
      editForm.value = { id: '', key: '', content: '', category: 'general', importance: 1 }
      await fetchMemories()
    }
  } catch {
    nMessage.error('保存失败')
  } finally {
    saving.value = false
  }
}

async function deleteMemory(id: string) {
  try {
    const res = await fetch(`/api/memory/${id}`, { method: 'DELETE' })
    if (res.ok) {
      nMessage.success('已删除')
      memories.value = memories.value.filter((m) => m.id !== id)
    }
  } catch {
    nMessage.error('删除失败')
  }
}

onMounted(() => {
  fetchMemories()
})
</script>

<style scoped>
.page-container {
  height: 100vh;
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
</style>
