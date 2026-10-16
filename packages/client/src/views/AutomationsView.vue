<template>
  <div class="page-container">
    <header class="page-header">
      <div>
        <h2>{{ t('automations.title') }}</h2>
        <p class="page-desc">{{ t('automations.desc') }}</p>
      </div>
      <n-button size="small" type="primary" @click="openCreate">
        <template #icon><SvgIcon name="plus" :size="14" /></template>
        {{ t('automations.create') }}
      </n-button>
    </header>

    <div class="automations-list" v-if="!loading">
      <n-card v-for="a in automations" :key="a.id" size="small" class="auto-card" :class="{ inactive: a.status !== 'active' }">
        <div class="auto-header">
          <div class="auto-name-row">
            <span class="auto-status-dot" :class="a.status"></span>
            <span class="auto-name">{{ a.name }}</span>
          </div>
          <div class="auto-actions">
            <n-button size="tiny" quaternary @click="triggerAutomation(a.id)" :title="t('automations.runNow')">
              <SvgIcon name="zap" :size="12" />
            </n-button>
            <n-button v-if="a.status==='active'" size="tiny" quaternary @click="toggleStatus(a.id, 'paused')" :title="t('automations.pause')">{{ t('automations.pause') }}</n-button>
            <n-button v-else size="tiny" quaternary @click="toggleStatus(a.id, 'active')" :title="t('automations.resume')">{{ t('automations.resume') }}</n-button>
            <n-button size="tiny" quaternary type="error" @click="deleteAutomation(a.id)">{{ t('automations.del') }}</n-button>
          </div>
        </div>
        <p class="auto-prompt">{{ a.prompt }}</p>
        <div class="auto-meta">
          <n-tag size="tiny" :bordered="false" :type="a.schedule_type==='once'?'warning':'info'">
            {{ a.schedule_type === 'once' ? t('automations.typeOnce') : a.schedule_type === 'event' ? t('automations.typeEvent') + (a.event_trigger ? ' · ' + a.event_trigger : '') : t('automations.typeRecurring') }}
          </n-tag>
          <span class="auto-schedule">{{ formatSchedule(a) }}</span>
          <span v-if="a.last_run_at" class="auto-last">{{ t('automations.lastRun') }}: {{ fmtTime(a.last_run_at) }}</span>
          <span v-if="a.next_run_at && a.status==='active'" class="auto-next">{{ t('automations.nextRun') }}: {{ fmtTime(a.next_run_at) }}</span>
        </div>
      </n-card>
      <n-empty v-if="automations.length===0" :description="t('automations.empty')" class="empty" />
    </div>

    <!-- Create Modal -->
    <n-modal v-model:show="showModal" preset="card" :title="t('automations.modalTitle')" style="max-width:520px" :mask-closable="false">
      <n-form label-placement="left" label-width="90">
        <n-form-item :label="t('automations.formName')"><n-input v-model:value="form.name" :placeholder="t('automations.namePh')" /></n-form-item>
        <n-form-item :label="t('automations.formType')">
          <n-radio-group v-model:value="form.schedule_type">
            <n-radio value="recurring">{{ t('automations.typeRecurring') }}</n-radio>
            <n-radio value="once">{{ t('automations.typeOnce') }}</n-radio>
            <n-radio value="event">{{ t('automations.typeEvent') }}</n-radio>
          </n-radio-group>
        </n-form-item>
        <n-form-item v-if="form.schedule_type==='event'" :label="t('automations.formTrigger')">
          <n-select v-model:value="form.event_trigger" :options="eventOptions" style="width:100%" :placeholder="t('automations.triggerPh')" />
        </n-form-item>
        <n-form-item v-if="form.schedule_type==='event'" :label="t('automations.formContext')">
          <n-input v-model:value="form.event_context" :placeholder="t('automations.contextPh')" size="small" />
        </n-form-item>
        <n-form-item v-if="form.schedule_type==='recurring'" :label="t('automations.formFreq')">
          <n-select v-model:value="form.freq" :options="freqOptions" style="width:140px" />
        </n-form-item>
        <n-form-item v-if="form.schedule_type==='recurring'" :label="t('automations.formTime')">
          <n-time-picker v-model:value="form.time" format="HH:mm" style="width:120px" />
        </n-form-item>
        <n-form-item v-if="form.schedule_type==='recurring'&&form.freq==='WEEKLY'" :label="t('automations.formWeekday')">
          <n-select v-model:value="form.weekdays" :options="weekdayOptions" multiple style="width:200px" :placeholder="t('automations.weekdayPh')" />
        </n-form-item>
        <n-form-item v-if="form.schedule_type==='once'" :label="t('automations.formRunAt')">
          <n-date-picker v-model:value="form.scheduled_at" type="datetime" style="width:100%" />
        </n-form-item>
        <n-form-item label="Prompt">
          <n-input v-model:value="form.prompt" type="textarea" :rows="3" :placeholder="t('automations.promptPh')" />
        </n-form-item>
        <n-form-item :label="t('automations.formNotify')">
          <n-select v-model:value="form.notify_channel" :options="notifyOptions" style="width:100%" :placeholder="t('automations.notifyPh')" clearable />
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showModal=false">{{ t('automations.cancel') }}</n-button>
        <n-button type="primary" @click="createAutomation">{{ t('automations.submit') }}</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
const { t } = useI18n({ useScope: 'global' })
import { useI18n } from 'vue-i18n'
import { ref, reactive, onMounted } from 'vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'

interface Automations {
  id: string; name: string; prompt: string; status: string; schedule_type: string
  rrule: string; scheduled_at: string | null; next_run_at: number; last_run_at: number | null
  model_id: string | null; created_at: number; updated_at: number
  event_trigger?: string
}

const automations = ref<Automations[]>([])
const loading = ref(false)
const showModal = ref(false)
const form = reactive({
  name: '', prompt: '', schedule_type: 'recurring',
  freq: 'DAILY', time: 32400000, // 9:00
  weekdays: [] as string[], scheduled_at: null as number | null,
  notify_channel: null as string | null,
  event_trigger: 'file-changed', event_context: '',
})

const eventOptions = computed(() => [
  { label: t('automations.evFileChanged'), value: 'file-changed' },
  { label: t('automations.evMessage'), value: 'message-received' },
  { label: t('automations.evManual'), value: 'manual' },
])

const notifyOptions = computed(() => [
  { label: t('automations.chAll'), value: 'all' },
  { label: t('automations.chWechat'), value: 'wechat' },
  { label: 'QQ', value: 'qq' },
  { label: 'Telegram', value: 'telegram' },
  { label: 'Discord', value: 'discord' },
  { label: 'Slack', value: 'slack' },
  { label: t('automations.chFeishu'), value: 'feishu' },
])

const freqOptions = computed(() => [
  { label: t('automations.fDaily'), value: 'DAILY' },
  { label: t('automations.fWeekly'), value: 'WEEKLY' },
  { label: t('automations.fMonthly'), value: 'MONTHLY' },
  { label: t('automations.fHourly'), value: 'HOURLY' },
])

const weekdayOptions = computed(() => [
  { label: t('automations.wMo'), value: 'MO' }, { label: t('automations.wTu'), value: 'TU' }, { label: t('automations.wWe'), value: 'WE' },
  { label: t('automations.wTh'), value: 'TH' }, { label: t('automations.wFr'), value: 'FR' }, { label: t('automations.wSa'), value: 'SA' }, { label: t('automations.wSu'), value: 'SU' },
])

function buildRrule(): string {
  const { freq, time, weekdays } = form
  const hours = Math.floor(time / 3600000)
  const minutes = Math.floor((time % 3600000) / 60000)
  const ts = `${String(hours).padStart(2,'0')}${String(minutes).padStart(2,'0')}00`
  let rrule = `FREQ=${freq};BYTIME=T${ts}`
  if (freq === 'WEEKLY' && weekdays.length > 0) {
    rrule += `;BYDAY=${weekdays.join(',')}`
  }
  return rrule
}

function formatSchedule(a: Automations): string {
  if (a.schedule_type === 'event') return t('automations.schedEvent', { name: a.event_trigger || t('automations.evUnspecified') })
  if (a.schedule_type === 'once') return t('automations.schedOnce', { time: a.scheduled_at ? new Date(a.scheduled_at).toLocaleString() : '--' })
  const match = a.rrule?.match(/FREQ=(\w+)/)
  const freq = match?.[1] || ''
  const tm = a.rrule?.match(/T(\d{2})(\d{2})/)
  const time = tm ? `${tm[1]}:${tm[2]}` : ''
  const days = a.rrule?.match(/BYDAY=([^;]+)/)?.[1]
  if (freq === 'DAILY') return t('automations.schedDaily', { time })
  if (freq === 'WEEKLY' && days) return t('automations.schedWeekly', { days, time })
  if (freq === 'MONTHLY') return t('automations.schedMonthly', { time })
  if (freq === 'HOURLY') return t('automations.schedHourly')
  return a.rrule || '--'
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })
}

async function loadAutomations() {
  loading.value = true
  try { const r = await fetch('/api/automations'); automations.value = await r.json() } catch(e){}
  loading.value = false
}

async function createAutomation() {
  const rrule = form.schedule_type === 'recurring' ? buildRrule() : ''
  const scheduledAt = form.schedule_type === 'once' ? form.scheduled_at ? new Date(form.scheduled_at).toISOString() : null : null
  // 事件型：prompt 里支持 {{context}} 占位符（事件详情注入），前端提供独立上下文输入
  let prompt = form.prompt
  if (form.schedule_type === 'event' && form.event_context && !prompt.includes('{{context}}')) {
    prompt = `${prompt}\n\n[Event context] ${form.event_context}`
  }

  await fetch('/api/automations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: form.name, prompt,
      schedule_type: form.schedule_type, rrule, scheduled_at: scheduledAt,
      notify_channel: form.notify_channel || '',
      event_trigger: form.schedule_type === 'event' ? form.event_trigger : '',
    }),
  })
  showModal.value = false
  form.name = ''; form.prompt = ''; form.notify_channel = null
  await loadAutomations()
}

async function toggleStatus(id: string, status: string) {
  await fetch(`/api/automations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  await loadAutomations()
}

async function triggerAutomation(id: string) {
  await fetch(`/api/automations/${id}/trigger`, { method: 'POST' })
  await loadAutomations()
}

async function deleteAutomation(id: string) {
  await fetch(`/api/automations/${id}`, { method: 'DELETE' })
  await loadAutomations()
}

function openCreate() {
  form.name = ''; form.prompt = ''; form.schedule_type = 'recurring'
  form.freq = 'DAILY'; form.time = 32400000; form.weekdays = []
  form.scheduled_at = null; form.notify_channel = null
  showModal.value = true
}

onMounted(() => { loadAutomations() })
</script>

<style scoped>
.page-container { height:100%; display:flex; flex-direction:column }
.page-header { display:flex; align-items:center; justify-content:space-between; padding:16px 24px; border-bottom:1px solid var(--border-color); flex-shrink:0 }
.page-header h2 { font-size:var(--text-lg); font-weight:600; margin:0 }
.page-desc { font-size:var(--text-sm); color:var(--text-muted); margin:4px 0 0 }

.automations-list { flex:1; overflow-y:auto; padding:24px; display:flex; flex-direction:column; gap:12px }
.auto-card { border:1px solid var(--border-color); transition:border-color var(--duration-fast) }
.auto-card:hover { border-color:var(--border-hover) }
.auto-card.inactive { opacity:.5 }
.auto-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px }
.auto-name-row { display:flex; align-items:center; gap:8px }
.auto-status-dot { width:8px; height:8px; border-radius:50%; background:var(--text-muted) }
.auto-status-dot.active { background:var(--success) }
.auto-status-dot.paused { background:var(--warning) }
.auto-status-dot.completed { background:var(--text-muted) }
.auto-name { font-weight:600; font-size:var(--text-base) }
.auto-actions { display:flex; gap:2px }
.auto-prompt { font-size:var(--text-sm); color:var(--text-secondary); margin:0 0 10px; line-height:1.6 }
.auto-meta { display:flex; gap:10px; align-items:center; flex-wrap:wrap }
.auto-schedule { font-size:var(--text-xs); color:var(--text-muted) }
.auto-last, .auto-next { font-size:var(--text-xs); color:var(--text-muted) }
.auto-next { color:var(--accent) }
.empty { margin-top:80px }
</style>
