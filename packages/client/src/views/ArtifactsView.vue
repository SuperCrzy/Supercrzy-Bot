<script setup lang="ts">
/**
 * Artifact centre.
 *
 * Artifacts were only visible inline in the turn that produced them, so finding a
 * file from three conversations ago meant remembering which one, then scrolling.
 * This lists them across sessions with the session title alongside, so the entry
 * point is the file rather than the conversation.
 *
 * Nothing here is new data: /api/artifacts already returns every row.
 */
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const { t } = useI18n({ useScope: 'global' })
const router = useRouter()

interface Row {
  id: string
  session_id: string
  session_title?: string
  name: string
  path: string
  mime?: string
  size?: number
  action?: string
  created_at?: string
}

const rows = ref<Row[]>([])
const loading = ref(false)
const query = ref('')
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await fetch('/api/artifacts')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const data = await r.json()
    rows.value = Array.isArray(data) ? data : (data.artifacts || [])
  } catch (e: any) {
    error.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return rows.value
  return rows.value.filter((r) =>
    r.name.toLowerCase().includes(q) || (r.session_title || '').toLowerCase().includes(q) || (r.path || '').toLowerCase().includes(q))
})

function sizeText(n?: number): string {
  if (!n || n < 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

function openInSession(r: Row) {
  router.push({ name: 'Chat', query: { session: r.session_id } })
}

async function copyPath(r: Row) {
  // Same helper the artifact menu uses: navigator.clipboard alone silently fails in
  // the packaged build when the document is not focused.
  const { copyToClipboard } = await import('@/utils/clipboard')
  await copyToClipboard(r.path)
}

onMounted(load)
</script>

<template>
  <div class="artifacts-page">
    <div class="page-head">
      <h2>{{ t('nav.artifacts') }}</h2>
      <div class="head-actions">
        <n-input v-model:value="query" size="small" :placeholder="t('artifacts.searchPlaceholder')" clearable class="search" />
        <n-button size="small" @click="load" :loading="loading">{{ t('common.refresh') }}</n-button>
      </div>
    </div>

    <n-spin :show="loading">
      <div v-if="error" class="hint err">{{ error }}</div>
      <n-empty v-else-if="!loading && filtered.length === 0" :description="t('artifacts.empty')" />
      <div v-else class="grid">
        <div v-for="r in filtered" :key="r.id" class="card">
          <div class="card-name" :title="r.path">{{ r.name }}</div>
          <div class="card-meta">
            <span v-if="sizeText(r.size)">{{ sizeText(r.size) }}</span>
            <span v-if="r.action" class="tag">{{ r.action }}</span>
          </div>
          <div v-if="r.session_title" class="card-session" :title="r.session_title">{{ r.session_title }}</div>
          <div class="card-actions">
            <n-button size="tiny" @click="openInSession(r)">{{ t('artifacts.openSession') }}</n-button>
            <n-button size="tiny" quaternary @click="copyPath(r)">{{ t('detail.menuCopyPath') }}</n-button>
          </div>
        </div>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.artifacts-page { padding: 16px 20px; height: 100%; overflow: auto; }
.page-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 16px; margin-bottom: 14px;
}
.page-head h2 { font-size: 15px; font-weight: 600; margin: 0; color: var(--text-primary); }
.head-actions { display: flex; align-items: center; gap: 8px; }
.search { width: 220px; }
.hint { color: var(--text-tertiary); font-size: 12px; padding: 24px 0; }
.hint.err { color: var(--error); }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
.card {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  background: var(--bg-sidebar);
  display: flex; flex-direction: column; gap: 6px;
}
.card-name {
  font-size: 13px; font-weight: 500; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.card-meta {
  display: flex; align-items: center; gap: 8px;
  font-size: 11px; color: var(--text-tertiary);
}
.tag {
  padding: 0 5px; border-radius: 3px;
  background: var(--bg-hover, rgba(0,0,0,.06));
}
.card-session {
  font-size: 11px; color: var(--text-tertiary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.card-actions { display: flex; gap: 4px; margin-top: 2px; }
</style>
