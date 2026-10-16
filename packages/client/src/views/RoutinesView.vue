<template>
  <div class="page-container">
    <header class="page-header">
      <h2>{{ t('routines.title') }}</h2>
      <p class="page-desc">{{ t('routines.desc') }}</p>
      <div class="header-actions">
        <n-select
          v-model:value="fromSessionId"
          :options="sessionOpts"
          :placeholder="t('routines.fromSessionPh')"
          clearable
          size="small"
          style="width: 220px"
        />
        <n-input v-model:value="fromSessionName" size="small" :placeholder="t('routines.namePh')" style="width: 160px" />
        <n-button size="small" :loading="savingFromSession" @click="saveFromSession">{{ t('routines.saveFromSession') }}</n-button>
        <n-button size="small" type="primary" @click="showCreate = true">{{ t('routines.create') }}</n-button>
      </div>
    </header>

    <div class="routine-content">
      <n-spin :show="loading">
        <div v-if="routines.length === 0" class="empty-hint">
          <p>{{ t('routines.empty') }}</p>
          <p class="hint">{{ t('routines.emptyHint') }}</p>
        </div>
        <n-card v-for="r in routines" :key="r.id" size="small" class="routine-card">
          <div class="routine-top">
            <div class="routine-title">
              <span class="routine-name">{{ r.name }}</span>
              <span class="routine-runs">{{ t('routines.runs', { n: r.runCount }) }}</span>
            </div>
            <div class="routine-actions">
              <n-button size="tiny" type="primary" @click="runRoutine(r)">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="margin-right:3px"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                {{ t('routines.run') }}
              </n-button>
              <n-button size="tiny" quaternary @click="editRoutine(r)">{{ t('routines.edit') }}</n-button>
              <n-popconfirm @positive-click="deleteRoutine(r.id)">
                <template #trigger>
                  <n-button size="tiny" quaternary type="error">{{ t('routines.del') }}</n-button>
                </template>
                {{ t('routines.delConfirm') }}
              </n-popconfirm>
            </div>
          </div>
          <div class="routine-desc">{{ r.description || t('routines.noDesc') }}</div>
          <div v-if="r.steps && r.steps.length" class="routine-steps">
            <div v-for="(s, i) in r.steps" :key="i" class="routine-step">
              <span class="step-no">{{ i + 1 }}</span>
              <span class="step-tool">{{ s.tool }}</span>
              <span class="step-note">{{ s.note }}</span>
            </div>
          </div>
          <div class="routine-time">{{ formatTime(r.updatedAt) }}</div>
        </n-card>
      </n-spin>
    </div>

    <!-- 新建/编辑 -->
    <n-modal v-model:show="showCreate" preset="card" :title="editId ? t('routines.modalEdit') : t('routines.modalCreate')" style="max-width: 480px">
      <div class="modal-form">
        <div class="form-group">
          <label>{{ t('routines.formName') }}</label>
          <n-input v-model:value="form.name" :placeholder="t('routines.nameExamplePh')" />
        </div>
        <div class="form-group">
          <label>{{ t('routines.formDesc') }}</label>
          <n-input v-model:value="form.description" type="textarea" :rows="6" :placeholder="t('routines.descPh')" />
        </div>
      </div>
      <template #footer>
        <n-button @click="showCreate = false">{{ t('routines.cancel') }}</n-button>
        <n-button type="primary" :loading="saving" @click="saveRoutine">{{ t('routines.submit') }}</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n({ useScope: 'global' })
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'

interface RoutineStep { tool: string; note: string }
interface Routine {
  id: string; name: string; description: string; steps: RoutineStep[]
  sourceSessionId?: string; runCount: number; createdAt: string; updatedAt: string
}

const router = useRouter()
const nMessage = useMessage()
const routines = ref<Routine[]>([])
const loading = ref(false)
const saving = ref(false)
const savingFromSession = ref(false)
const showCreate = ref(false)
const editId = ref('')
const form = ref({ name: '', description: '' })
const fromSessionId = ref<string | null>(null)
const fromSessionName = ref('')
const sessions = ref<Array<{ id: string; title: string }>>([])

const sessionOpts = computed(() => sessions.value.map((s) => ({ label: s.title || t('routines.noTitle'), value: s.id })))

function formatTime(d: string): string {
  if (!d) return ''
  try { return new Date(d).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) } catch { return '' }
}

async function loadRoutines() {
  loading.value = true
  try {
    const r = await fetch('/api/routines')
    if (r.ok) routines.value = await r.json()
  } finally { loading.value = false }
}

async function loadSessions() {
  try {
    const r = await fetch('/api/sessions')
    if (r.ok) {
      const data = await r.json()
      sessions.value = (data.sessions || data || []).slice(0, 50)
    }
  } catch { /* ignore */ }
}

function editRoutine(r: Routine) {
  editId.value = r.id
  form.value = { name: r.name, description: r.description }
  showCreate.value = true
}

async function saveRoutine() {
  if (!form.value.name.trim()) { nMessage.warning(t('routines.needName')); return }
  saving.value = true
  try {
    const isEdit = !!editId.value
    const r = await fetch(`/api/routines${isEdit ? '/' + editId.value : ''}`, {
      method: isEdit ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form.value),
    })
    if (r.ok) {
      nMessage.success(isEdit ? t('routines.updated') : t('routines.created'))
      showCreate.value = false
      editId.value = ''
      form.value = { name: '', description: '' }
      await loadRoutines()
    }
  } finally { saving.value = false }
}

async function deleteRoutine(id: string) {
  await fetch(`/api/routines/${id}`, { method: 'DELETE' })
  routines.value = routines.value.filter((r) => r.id !== id)
  nMessage.success(t('routines.deleted'))
}

async function saveFromSession() {
  if (!fromSessionId.value) { nMessage.warning(t('routines.needSession')); return }
  savingFromSession.value = true
  try {
    const r = await fetch('/api/routines/from-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: fromSessionId.value, name: fromSessionName.value }),
    })
    const d = await r.json()
    if (d.success) {
      nMessage.success(t('routines.saved', { name: d.name }))
      fromSessionId.value = null
      fromSessionName.value = ''
      await loadRoutines()
    } else {
      nMessage.error(d.error || t('routines.saveFailed'))
    }
  } finally { savingFromSession.value = false }
}

/** 执行例程：把描述作为指令发到聊天页（一键重放） */
async function runRoutine(r: Routine) {
  const text = `${t('routines.runPrefix')} ${r.name}\n\n${r.description || ''}`.trim()
  await fetch(`/api/routines/${r.id}/run`, { method: 'POST' })
  // 跳转到聊天页并把例程作为消息发出（ChatView 监听 supercrzy:send-prompt）
  router.push('/')
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('supercrzy:send-prompt', { detail: text }))
  }, 300)
}

onMounted(() => {
  loadRoutines()
  loadSessions()
})
</script>

<style scoped>
.page-container { height: 100%; display: flex; flex-direction: column; }
.page-header { padding: 16px 24px; border-bottom: 1px solid var(--border-color); flex-shrink: 0; }
.page-header h2 { font-size: 16px; font-weight: 600; margin: 0; }
.page-desc { font-size: 12px; color: var(--text-muted); margin: 4px 0 12px; }
.header-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.routine-content { flex: 1; overflow-y: auto; padding: 16px 24px; display: flex; flex-direction: column; gap: 10px; }
.routine-card { border: 1px solid var(--border-color); }
.routine-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.routine-title { display: flex; align-items: center; gap: 8px; }
.routine-name { font-size: 14px; font-weight: 600; }
.routine-runs { font-size: 11px; color: var(--text-muted); }
.routine-actions { display: flex; gap: 4px; align-items: center; }
.routine-desc { font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; white-space: pre-wrap; margin-bottom: 8px; }
.routine-steps { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.routine-step { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.step-no { width: 18px; height: 18px; border-radius: 50%; background: var(--bg-tertiary); display: inline-flex; align-items: center; justify-content: center; font-size: 10px; color: var(--text-secondary); flex-shrink: 0; }
.step-tool { font-family: var(--font-mono); color: var(--accent); font-size: 11px; }
.step-note { color: var(--text-secondary); }
.routine-time { font-size: 11px; color: var(--text-muted); }
.empty-hint { text-align: center; margin-top: 60px; color: var(--text-muted); }
.empty-hint p { margin: 4px 0; }
.empty-hint .hint { font-size: 12px; }
.modal-form { display: flex; flex-direction: column; gap: 12px; }
.form-group label { display: block; font-size: 13px; font-weight: 500; color: var(--text-secondary); margin-bottom: 4px; }
</style>
