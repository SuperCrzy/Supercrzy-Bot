<template>
  <div class="page-container">
    <!-- ====== 左栏：任务列表 ====== -->
    <div class="panel-left">
      <div class="panel-left-header">
        <h2>Tasks</h2>
        <n-select v-model:value="filterStatus" :options="statusOptions" size="small" clearable placeholder="All status" style="width:130px" />
      </div>

      <div class="stats-bar">
        <span class="stat" :class="{ active: !filterStatus }" @click="filterStatus=null">All <strong>{{ stats.total }}</strong></span>
        <span class="stat pending" :class="{ active: filterStatus==='pending' }" @click="filterStatus='pending'">Pending <strong>{{ stats.pending }}</strong></span>
        <span class="stat in-progress" :class="{ active: filterStatus==='in_progress' }" @click="filterStatus='in_progress'">Active <strong>{{ stats.in_progress }}</strong></span>
        <span class="stat completed" :class="{ active: filterStatus==='completed' }" @click="filterStatus='completed'">Done <strong>{{ stats.completed }}</strong></span>
      </div>

      <div class="tasks-scroll" v-if="!loading">
        <div
          v-for="t in filteredTasks"
          :key="t.id"
          class="task-row"
          :class="[t.status, { selected: selectedId === t.id }]"
          @click="selectTask(t.id)"
        >
          <div class="task-status-dot" :class="t.status"></div>
          <div class="task-main">
            <div class="task-subject">{{ t.subject }}</div>
            <div class="task-desc" v-if="t.description">{{ t.description }}</div>
            <div class="task-progress-wrap" v-if="t.progress > 0 || t.status === 'in_progress'">
              <div class="task-progress-bar"><div class="task-progress-fill" :style="{width: t.progress+'%'}"></div></div>
              <span class="task-progress-text">{{ t.progress || 0 }}%</span>
            </div>
            <div class="task-eta" v-if="getEtaText(t)">{{ getEtaText(t) }}</div>
          </div>
          <div class="task-meta-right">
            <span class="task-sub-count" v-if="getChildren(t.id).length">{{ getChildren(t.id).length }} sub</span>
            <span class="task-date">{{ fmtDate(t.created_at) }}</span>
          </div>
        </div>
        <n-empty v-if="filteredTasks.length===0" description="No tasks" class="empty-state" />
      </div>
      <div v-else class="loading-state">Loading...</div>

      <div class="left-footer">
        <n-button size="small" type="primary" block @click="openCreate">
          <template #icon><SvgIcon name="plus" :size="14" /></template>
          New Task
        </n-button>
      </div>
    </div>

    <!-- ====== 中栏：任务详情 ====== -->
    <div class="panel-center" :class="{ empty: !selected }">
      <template v-if="selected">
        <div class="detail-header">
          <div class="detail-title-row">
            <input
              class="detail-title-input"
              :value="editSubject"
              @input="editSubject = ($event.target as HTMLInputElement).value"
              @blur="saveDetail"
              placeholder="Task subject"
            />
            <n-dropdown trigger="click" :options="statusActions(selected)" @select="(k: string) => updateTask(selected!.id, {status: k})">
              <n-tag :type="statusTagType(selected.status)" size="small" style="cursor:pointer">
                {{ statusLabel(selected.status) }}
              </n-tag>
            </n-dropdown>
          </div>
          <div class="detail-meta">
            <span>Created {{ fmtDate(selected.created_at) }}</span>
            <span v-if="selected.updated_at !== selected.created_at">· Updated {{ fmtDate(selected.updated_at) }}</span>
            <span v-if="selected.session_id">· Session {{ selected.session_id.slice(0,8) }}</span>
          </div>
        </div>

        <div class="detail-body">
          <div class="detail-section">
            <label>Description</label>
            <textarea
              class="detail-desc-input"
              :value="editDescription"
              @input="editDescription = ($event.target as HTMLTextAreaElement).value"
              @blur="saveDetail"
              placeholder="Add description..."
              rows="3"
            ></textarea>
          </div>

          <div class="detail-section">
            <label>Progress</label>
            <div class="progress-edit-row">
              <input
                type="range" min="0" max="100" :value="autoProgress"
                @input="debouncedUpdateProgress($event)"
                class="progress-slider"
              />
              <span class="progress-val">{{ autoProgress }}%</span>
            </div>
            <div class="progress-auto-note" v-if="subs.length > 0 && autoProgress !== selected.progress">
              Auto-calc from {{ subs.filter(s=>s.status==='completed').length }}/{{ subs.length }} subtasks
            </div>
          </div>

          <div class="detail-section" v-if="etaBreakdown && etaBreakdown.remaining > 0">
            <label>⏱ Estimated Time</label>
            <div class="eta-breakdown">
              <div class="eta-row">
                <span class="eta-label">Remaining</span>
                <span class="eta-value">{{ etaBreakdown.remaining }} subtask{{ etaBreakdown.remaining !== 1 ? 's' : '' }}</span>
              </div>
              <div class="eta-row" v-if="etaBreakdown.avgHours">
                <span class="eta-label">Avg speed</span>
                <span class="eta-value">{{ etaBreakdown.avgHours }}h per subtask</span>
              </div>
              <div class="eta-row eta-total">
                <span class="eta-label">ETA</span>
                <span class="eta-value">{{ etaBreakdown.etaText }}</span>
              </div>
            </div>
          </div>

          <div class="detail-section">
            <label>
              Sub-tasks
              <span class="sub-count-badge" v-if="subs.length">{{ subs.length }}</span>
            </label>
            <div class="sub-tasks-list" v-if="subs.length">
              <div v-for="sub in subs" :key="sub.id" class="sub-task-row" :class="sub.status">
                <div class="task-status-dot small" :class="sub.status"></div>
                <span class="sub-task-subject">{{ sub.subject }}</span>
                <div class="sub-task-right">
                  <span class="sub-progress" v-if="sub.progress > 0">{{ sub.progress }}%</span>
                  <n-dropdown trigger="click" :options="statusActions(sub)" @select="(k: string) => updateTask(sub.id, {status: k})">
                    <n-button size="tiny" quaternary><SvgIcon name="chevron-down" :size="10" /></n-button>
                  </n-dropdown>
                  <n-button size="tiny" quaternary type="error" @click.stop="deleteTask(sub.id)">
                    <SvgIcon name="x" :size="10" />
                  </n-button>
                </div>
              </div>
            </div>
            <button class="add-sub-btn" @click="openCreateSub(selected.id)">+ Add sub-task</button>
          </div>
        </div>

        <div class="detail-footer">
          <n-button size="small" quaternary type="error" @click="deleteTask(selected.id); selectedId = null">
            Delete Task
          </n-button>
        </div>
      </template>
      <div v-else class="empty-center">
        <SvgIcon name="chevron-down" :size="24" style="opacity:0.2; transform:rotate(-90deg)" />
        <span>Select a task to view details</span>
      </div>
    </div>

    <!-- ====== 右栏：时间线 ====== -->
    <div class="panel-right">
      <div class="timeline-header">
        <h3>Timeline</h3>
        <span class="timeline-sub">Gantt view</span>
      </div>
      <div class="timeline-body" v-if="timelineTasks.length > 0">
        <svg :width="timelineSvgW" :height="timelineSvgH" class="timeline-svg">
          <!-- Month grid lines -->
          <line v-for="(m, i) in monthGrid" :key="'g'+i"
            :x1="m.x" :y1="0" :x2="m.x" :y2="timelineSvgH"
            stroke="var(--border-color)" stroke-width="1" stroke-dasharray="4,4"
          />
          <!-- Month labels -->
          <text v-for="(m, i) in monthGrid" :key="'ml'+i"
            :x="m.x + 4" :y="14" fill="var(--text-muted)" font-size="11"
          >{{ m.label }}</text>

          <!-- Task bars -->
          <g v-for="(t, i) in timelineTasksAugmented" :key="t.id">
            <rect
              :x="t.barX" :y="t.barY" :width="t.barW" :height="18" rx="4"
              :fill="barColor(t.status)" :opacity="selectedId === t.id ? 1 : 0.7"
              style="cursor:pointer; transition: opacity 0.2s"
              @click="selectTask(t.id)"
            />
            <text
              :x="barLabelX(t)" :y="t.barY + 13"
              :fill="selectedId === t.id ? '#fff' : 'var(--text-primary)'"
              font-size="11"
              style="pointer-events:none"
            >{{ truncate(t.subject, 18) }}</text>
          </g>
        </svg>
      </div>
      <n-empty v-else description="No tasks with dates" class="empty-state" />
    </div>

    <!-- Create Modal -->
    <n-modal v-model:show="showModal" preset="card" :title="parentId ? 'Add Sub-task' : 'New Task'" style="max-width:480px" :mask-closable="false">
      <n-form label-placement="left" label-width="80">
        <n-form-item label="Subject"><n-input v-model:value="form.subject" placeholder="Task subject" /></n-form-item>
        <n-form-item label="Description"><n-input v-model:value="form.description" type="textarea" :rows="2" placeholder="Optional" /></n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showModal=false">Cancel</n-button>
        <n-button type="primary" @click="createTask">{{ parentId ? 'Add' : 'Create' }}</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue'
import SvgIcon from '@/components/ui/SvgIcon.vue'

interface Task {
  id: string; session_id: string | null; subject: string; description: string
  status: string; parent_id: string | null; sort_order: number; progress: number
  blocked_by: string | null; created_at: string; updated_at: string
}

const tasks = ref<Task[]>([])
const loading = ref(false)
const filterStatus = ref<string | null>(null)
const selectedId = ref<string | null>(null)
const showModal = ref(false)
const parentId = ref<string | null>(null)
const form = reactive({ subject: '', description: '' })
const editSubject = ref('')
const editDescription = ref('')
let progressTimer: ReturnType<typeof setTimeout> | null = null

const selected = computed(() => tasks.value.find(t => t.id === selectedId.value) || null)
const subs = computed(() => selected.value ? getChildren(selected.value.id) : [])

const stats = computed(() => {
  const all = tasks.value
  return {
    total: all.length,
    pending: all.filter(t => t.status === 'pending').length,
    in_progress: all.filter(t => t.status === 'in_progress').length,
    completed: all.filter(t => t.status === 'completed').length,
  }
})

const statusOptions = [
  { label: 'Pending', value: 'pending' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
]

const filteredTasks = computed(() => {
  let list = tasks.value.filter(t => !t.parent_id)
  if (filterStatus.value) list = list.filter(t => t.status === filterStatus.value)
  return list.sort((a, b) => a.sort_order - b.sort_order)
})

// ── 时间线数据 ──
const timelineTasks = computed(() => {
  const topLevel = filteredTasks.value.filter(t => t.created_at)
  if (topLevel.length === 0) return []
  return topLevel.slice(0, 20) // max 20 bars
})

const timelineRange = computed(() => {
  const tts = timelineTasks.value
  if (tts.length === 0) return { min: new Date(), max: new Date() }
  const times = tts.map(t => new Date(t.created_at).getTime())
  return {
    min: new Date(Math.min(...times)),
    max: new Date(Math.max(...times, Date.now())),
  }
})

const timelineSvgW = computed(() => 360)
const timelineSvgH = computed(() => Math.max(60, timelineTasks.value.length * 32 + 20))

const monthGrid = computed(() => {
  const { min, max } = timelineRange.value
  const range = max.getTime() - min.getTime() || 1
  const months: { label: string; x: number }[] = []
  const cursor = new Date(min.getFullYear(), min.getMonth(), 1)
  const padLeft = 28
  const drawW = timelineSvgW.value - padLeft - 12
  while (cursor <= max) {
    const label = `${cursor.getFullYear() % 100}/${cursor.getMonth() + 1}`
    const pct = (cursor.getTime() - min.getTime()) / range
    months.push({ label, x: padLeft + pct * drawW })
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return months
})

function barColor(status: string) {
  return status === 'completed' ? 'var(--success)' :
    status === 'in_progress' ? 'var(--accent)' : 'var(--warning)'
}

function barLabelX(t: any) { return t.barX + 6 }

// 注入 barX/barY/barW 到 timelineTasks 元素
const timelineTasksAugmented = computed(() => {
  const { min, max } = timelineRange.value
  const range = max.getTime() - min.getTime() || 1
  const padLeft = 28
  const drawW = timelineSvgW.value - padLeft - 12
  return timelineTasks.value.map((t, i) => {
    const start = new Date(t.created_at).getTime()
    const barX = padLeft + ((start - min.getTime()) / range) * drawW
    const barW = Math.max(12, 40) // fixed width for visibility
    const barY = 28 + i * 32
    return { ...t, barX, barY, barW }
  })
})

function getChildren(parentId: string) {
  return tasks.value.filter(t => t.parent_id === parentId).sort((a, b) => a.sort_order - b.sort_order)
}

function statusActions(task: Task) {
  const labels: Record<string, string> = { pending: '◯ Pending', in_progress: '▶ In Progress', completed: '✓ Completed' }
  return Object.entries(labels)
    .filter(([k]) => k !== task.status)
    .map(([k, v]) => ({ label: v, key: k }))
}

function statusLabel(s: string) {
  const m: Record<string, string> = { pending: 'Pending', in_progress: 'In Progress', completed: 'Completed' }
  return m[s] || s
}

function statusTagType(s: string) {
  return s === 'completed' ? 'success' : s === 'in_progress' ? 'info' : 'warning'
}

function fmtDate(d: string) {
  if (!d) return ''
  const dt = new Date(d)
  return `${dt.getMonth()+1}/${dt.getDate()}`
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// ── Phase 1.5: 进度 & ETA ──
const autoProgress = computed(() => {
  if (!selected.value) return 0
  const subs = getChildren(selected.value.id)
  if (subs.length === 0) return selected.value.progress
  const done = subs.filter(s => s.status === 'completed').length
  return Math.round((done / subs.length) * 100)
})

function getEtaText(task: Task): string {
  const subs = getChildren(task.id)
  if (subs.length === 0) return ''
  const remaining = subs.filter(s => s.status !== 'completed')
  if (remaining.length === 0) return ''
  const done = subs.filter(s => s.status === 'completed')
  if (done.length === 0) return `~${remaining.length * 0.5}h` // default 30min/sub

  const avgMs = done.reduce((sum, s) => sum + (new Date(s.updated_at).getTime() - new Date(s.created_at).getTime()), 0) / done.length
  const avgH = avgMs / 3600000
  const etaH = remaining.length * avgH
  if (etaH < 0.1) return '< 6min'
  if (etaH < 1) return `~${Math.round(etaH * 60)}min`
  return `~${etaH.toFixed(1)}h`
}

const etaBreakdown = computed(() => {
  if (!selected.value) return null
  const subs = getChildren(selected.value.id)
  if (subs.length === 0) return null
  const remaining = subs.filter(s => s.status !== 'completed')
  const done = subs.filter(s => s.status === 'completed')
  if (done.length === 0) {
    const etaH = remaining.length * 0.5
    return { remaining: remaining.length, avgHours: null, etaText: etaH < 1 ? `~${Math.round(etaH*60)}min` : `~${etaH.toFixed(1)}h` }
  }
  const avgMs = done.reduce((sum, s) => sum + (new Date(s.updated_at).getTime() - new Date(s.created_at).getTime()), 0) / done.length
  const avgH = +(avgMs / 3600000).toFixed(2)
  const etaH = remaining.length * avgH
  const etaText = etaH < 0.1 ? '< 6min' : etaH < 1 ? `~${Math.round(etaH * 60)}min` : `~${etaH.toFixed(1)}h`
  return { remaining: remaining.length, avgHours: avgH, etaText }
})

function selectTask(id: string) {
  selectedId.value = id
  const t = tasks.value.find(x => x.id === id)
  if (t) {
    editSubject.value = t.subject
    editDescription.value = t.description || ''
  }
}

function saveDetail() {
  const t = selected.value
  if (!t) return
  const subject = editSubject.value.trim()
  const desc = editDescription.value.trim()
  if (subject !== t.subject || desc !== (t.description || '')) {
    updateTask(t.id, { subject: subject || t.subject, description: desc })
  }
}

function debouncedUpdateProgress(e: Event) {
  const val = parseInt((e.target as HTMLInputElement).value)
  if (progressTimer) clearTimeout(progressTimer)
  progressTimer = setTimeout(() => {
    if (selected.value) updateTask(selected.value.id, { progress: val })
  }, 300)
}

async function loadTasks() {
  loading.value = true
  try {
    const res = await fetch('/api/tasks')
    tasks.value = await res.json()
  } catch (e) { console.error(e) }
  loading.value = false
}

async function createTask() {
  if (!form.subject.trim()) return
  await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: form.subject, description: form.description, parent_id: parentId.value }),
  })
  showModal.value = false; parentId.value = null
  form.subject = ''; form.description = ''
  await loadTasks()
}

async function updateTask(id: string, data: any) {
  await fetch(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  await loadTasks()
  // 如果当前选中的任务被更新，刷新编辑态
  if (selectedId.value === id) {
    const t = tasks.value.find(x => x.id === id)
    if (t) {
      editSubject.value = t.subject
      editDescription.value = t.description || ''
    }
  }
}

async function deleteTask(id: string) {
  await fetch(`/api/tasks/${id}`, { method: 'DELETE' })
  if (selectedId.value === id) selectedId.value = null
  await loadTasks()
}

function openCreate() { parentId.value = null; showModal.value = true }
function openCreateSub(id: string) { parentId.value = id; showModal.value = true }

onMounted(() => { loadTasks() })
</script>

<style scoped>
.page-container {
  height: 100vh;
  display: flex;
  background: var(--bg-primary);
}

/* ============ LEFT PANEL ============ */
.panel-left {
  width: 320px;
  min-width: 280px;
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}
.panel-left-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.panel-left-header h2 {
  font-size: var(--text-lg);
  font-weight: 600;
  margin: 0;
}

.stats-bar {
  display: flex;
  gap: 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.stat {
  padding: 8px 12px;
  font-size: var(--text-sm);
  color: var(--text-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color var(--duration-fast), border-color var(--duration-fast);
}
.stat:hover { color: var(--text-secondary); }
.stat.active { color: var(--text-primary); border-bottom-color: var(--accent); }
.stat strong { color: var(--text-primary); }
.stat.pending.active { color: var(--warning); border-bottom-color: var(--warning); }
.stat.in-progress.active { color: var(--accent); border-bottom-color: var(--accent); }
.stat.completed.active { color: var(--success); border-bottom-color: var(--success); }

.tasks-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.task-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--duration-fast);
  border: 1px solid transparent;
  margin-bottom: 2px;
}
.task-row:hover { background: var(--bg-hover); }
.task-row.selected {
  background: var(--bg-active, rgba(79,70,229,0.08));
  border-color: var(--accent);
}
.task-row.completed { opacity: 0.55; }
.task-row.completed .task-subject { text-decoration: line-through; }

.task-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 5px;
  flex-shrink: 0;
  background: var(--text-muted);
}
.task-status-dot.in_progress { background: var(--accent); animation: pulse 1.5s ease infinite; }
.task-status-dot.completed { background: var(--success); }
.task-status-dot.small { width: 6px; height: 6px; margin-top: 7px; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

.task-main { flex: 1; min-width: 0; }
.task-subject { font-size: var(--text-sm); font-weight: 500; }
.task-desc {
  font-size: var(--text-xs);
  color: var(--text-muted);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.task-progress-wrap { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.task-progress-bar {
  flex: 1; height: 3px; border-radius: 2px;
  background: var(--bg-tertiary); overflow: hidden;
}
.task-progress-fill {
  height: 100%; border-radius: 2px;
  background: var(--accent);
  transition: width var(--duration-normal) var(--ease-out);
}
.task-progress-text { font-size: 11px; color: var(--text-muted); }

.task-meta-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}
.task-sub-count { font-size: 11px; color: var(--accent); }
.task-date { font-size: 11px; color: var(--text-muted); }

.left-footer { padding: 12px; border-top: 1px solid var(--border-color); flex-shrink: 0; }

.empty-state { margin-top: 60px; }
.loading-state { text-align: center; padding: 40px; color: var(--text-muted); }

/* ============ CENTER PANEL ============ */
.panel-center {
  flex: 1;
  min-width: 340px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
}
.panel-center.empty {
  align-items: center;
  justify-content: center;
}
.empty-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.detail-header { padding: 20px 24px 16px; border-bottom: 1px solid var(--border-color); }
.detail-title-row { display: flex; align-items: center; gap: 10px; }
.detail-title-input {
  flex: 1;
  font-size: var(--text-lg);
  font-weight: 600;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-primary);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  transition: border-color var(--duration-fast);
  outline: none;
}
.detail-title-input:hover { border-color: var(--border-color); }
.detail-title-input:focus { border-color: var(--accent); background: var(--bg-hover); }

.detail-meta {
  display: flex;
  gap: 4px;
  margin-top: 8px;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.detail-body { padding: 16px 24px; flex: 1; }
.detail-section { margin-bottom: 20px; }
.detail-section label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.sub-count-badge {
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
}

.detail-desc-input {
  width: 100%;
  font-size: var(--text-sm);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 10px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  resize: vertical;
  outline: none;
  transition: border-color var(--duration-fast);
}
.detail-desc-input:hover { border-color: var(--text-muted); }
.detail-desc-input:focus { border-color: var(--accent); }

.progress-edit-row { display: flex; align-items: center; gap: 12px; }
.progress-slider { flex: 1; accent-color: var(--accent); }
.progress-val { font-size: var(--text-sm); font-weight: 600; color: var(--accent); min-width: 36px; }

.sub-tasks-list { margin-bottom: 8px; }
.sub-task-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  margin-bottom: 4px;
  transition: background var(--duration-fast);
}
.sub-task-row:hover { background: var(--bg-hover); }
.sub-task-row.completed { opacity: 0.55; }
.sub-task-row.completed .sub-task-subject { text-decoration: line-through; }
.sub-task-subject { flex: 1; font-size: var(--text-sm); }
.sub-task-right { display: flex; align-items: center; gap: 4px; }
.sub-progress { font-size: 11px; color: var(--text-muted); }

.add-sub-btn {
  background: none;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-md);
  padding: 8px 12px;
  font-size: var(--text-sm);
  color: var(--accent);
  cursor: pointer;
  width: 100%;
  text-align: left;
  transition: border-color var(--duration-fast), background var(--duration-fast);
}
.add-sub-btn:hover { border-color: var(--accent); background: var(--bg-hover); }

.detail-footer { padding: 16px 24px; border-top: 1px solid var(--border-color); }

/* ============ RIGHT PANEL ============ */
.panel-right {
  width: 380px;
  min-width: 300px;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
}
.timeline-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.timeline-header h3 { font-size: var(--text-base); font-weight: 600; margin: 0; }
.timeline-sub { font-size: var(--text-xs); color: var(--text-muted); }

.timeline-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}
.timeline-svg { display: block; }

/* ============ ETA & Auto Progress ============ */
.task-eta {
  font-size: 11px;
  color: var(--accent);
  margin-top: 3px;
  font-weight: 500;
}
.progress-auto-note {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
  font-style: italic;
}
.eta-breakdown {
  background: var(--bg-primary);
  border-radius: var(--radius-md);
  padding: 12px;
}
.eta-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: var(--text-sm);
}
.eta-row.eta-total {
  border-top: 1px solid var(--border-color);
  margin-top: 4px;
  padding-top: 8px;
  font-weight: 600;
}
.eta-label { color: var(--text-muted); }
.eta-value { color: var(--text-primary); }
.eta-total .eta-value { color: var(--accent); font-size: var(--text-base); }
</style>
