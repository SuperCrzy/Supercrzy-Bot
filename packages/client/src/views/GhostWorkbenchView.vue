<template>
  <div class="ghost-workbench">
    <!-- 头部 -->
    <div class="wb-header">
      <div class="wb-title">
        <SvgIcon name="ghost" :size="20" />
        <div class="wb-title-text">
          <h1>{{ $t('ghost.workbench') }}</h1>
          <span class="wb-sub">{{ $t('ghost.workbenchDesc') }}</span>
        </div>
      </div>
      <div class="wb-header-actions">
        <!-- 观察者开关 -->
        <div class="wb-observer">
          <span class="wb-observer-label">{{ $t('ghost.observer') }}</span>
          <button class="wb-toggle" :class="{ on: observerEnabled }" @click="toggleObserver">
            <span class="wb-toggle-knob" />
          </button>
        </div>
      </div>
    </div>

    <!-- 场景库 -->
    <div class="wb-section">
      <div class="wb-section-title">{{ $t('ghost.scenes') }}</div>
      <div class="scene-grid">
        <button v-for="s in scenes" :key="s.key" class="scene-card" @click="startScene(s)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="scene-icon">
            <path v-for="(d, i) in s.icon" :key="i" :d="d" />
          </svg>
          <div class="scene-name">{{ s.title }}</div>
          <div class="scene-desc">{{ s.desc }}</div>
          <div class="scene-go">{{ $t('ghost.sceneGo') }}</div>
        </button>
      </div>
    </div>

    <!-- 自定义任务 -->
    <div class="wb-section">
      <div class="wb-section-title">{{ $t('ghost.customTask') }}</div>
      <div class="custom-task">
        <input
          v-model="customGoal"
          class="custom-task-input"
          :placeholder="$t('ghost.customPlaceholder')"
          @keyup.enter="startCustom"
        />
        <button class="custom-task-btn" :disabled="!customGoal.trim() || starting" @click="startCustom">
          {{ starting ? $t('ghost.starting') : $t('ghost.start') }}
        </button>
      </div>
      <label class="custom-task-mode" :class="{ on: researchMode }">
        <input type="checkbox" v-model="researchMode" />
        <span>{{ $t('ghost.researchMode') }}</span>
      </label>
    </div>

    <!-- 实时看板 -->
    <div class="wb-section">
      <div class="wb-section-title">
        {{ $t('ghost.board') }}
        <span class="wb-live" :class="{ connected: wsConnected }" />
      </div>

      <div v-if="tasks.length === 0" class="wb-empty">
        {{ $t('ghost.boardEmpty') }}
      </div>

      <div v-for="t in sortedTasks" :key="t.taskId" class="task-card" :class="`task--${t.status}`">
        <div class="task-head">
          <span class="task-name">{{ t.goal }}</span>
          <span class="task-status" :class="`status--${t.status}`">
            {{ statusText(t.status) }}
          </span>
          <span class="task-time">{{ timeText(t) }}</span>
          <button v-if="t.status === 'running' || t.status === 'decomposing'" class="task-stop" @click="stopTask(t)">
            {{ $t('ghost.stop') }}
          </button>
        </div>

        <!-- 子任务列表（运行中展开，完成折叠） -->
        <div v-if="t.ghosts.length > 0" class="task-ghosts">
          <div v-for="g in t.ghosts" :key="g.id" class="ghost-card" :class="`g--${g.status}`">
            <div class="ghost-head">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 3a7 7 0 0 0-7 7v7h14v-7a7 7 0 0 0-7-7z" /><path d="M8 14h.01M16 14h.01" />
              </svg>
              <span class="ghost-title">{{ g.title }}</span>
              <span class="ghost-status" :class="`gs--${g.status}`">{{ ghostStatusText(g.status) }}</span>
              <span class="ghost-progress" v-if="g.status === 'running'">{{ g.progress }}%</span>
            </div>
            <div v-if="g.status === 'running'" class="ghost-bar">
              <div class="ghost-bar-fill" :style="{ width: g.progress + '%' }" />
            </div>
            <div v-if="g.log && g.log.length > 0" class="ghost-log">
              <div v-for="(l, i) in g.log.slice(-3)" :key="i" class="ghost-log-line">{{ l }}</div>
            </div>
            <div v-if="g.error" class="ghost-error">{{ g.error }}</div>
          </div>
        </div>

        <!-- 汇总结果：右下角彩色按钮（点击展开/收起），报告独立成框可滚动 -->
        <div v-if="t.summary" class="task-summary" :class="{ expanded: expandedTask === t.taskId }">
          <button class="summary-head" @click="expandedTask = expandedTask === t.taskId ? '' : t.taskId">
            <span>{{ $t('ghost.summary') }}</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
          <div v-if="expandedTask === t.taskId" class="summary-body markdown-body" v-html="renderMarkdown(t.summary)" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import MarkdownIt from 'markdown-it'
import SvgIcon from '@/components/ui/SvgIcon.vue'

const md = new MarkdownIt({ html: false, linkify: true })
function renderMarkdown(content: string) {
  return content ? md.render(content) : ''
}

const { t } = useI18n({ useScope: 'global' })
const nMessage = useMessage()

// ---- 类型（对齐后端 ghost-engine）----
interface GhostGhost {
  id: string
  title: string
  status: 'running' | 'done' | 'failed' | 'stopped'
  progress: number
  log: string[]
  output: string
  error?: string
  startedAt: number
}
interface GhostTask {
  taskId: string
  goal: string
  status: 'decomposing' | 'running' | 'summarizing' | 'done' | 'failed' | 'stopped'
  createdAt: number
  finishedAt?: number
  subtasks: Array<{ id: string; title: string }>
  ghosts: GhostGhost[]
  summary: string
  error?: string
}

// ---- 状态 ----
const tasks = ref<GhostTask[]>([])
const customGoal = ref('')
const starting = ref(false)
const researchMode = ref(false)  // P3: 深度研究模式（多幽灵并行调研，出 3+ 页报告）
const expandedTask = ref('')
const observerEnabled = ref(true)
const wsConnected = ref(false)
let ws: WebSocket | null = null
let wsTimer: ReturnType<typeof setInterval> | null = null

// 场景库（图标为 SVG path 数组）
const scenes = [
  {
    key: 'health',
    title: t('ghost.sceneHealth'),
    desc: t('ghost.sceneHealthDesc'),
    icon: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
    goal: t('ghost.sceneHealthGoal'),
  },
  {
    key: 'refactor',
    title: t('ghost.sceneRefactor'),
    desc: t('ghost.sceneRefactorDesc'),
    icon: ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6'],
    goal: t('ghost.sceneRefactorGoal'),
  },
  {
    key: 'research',
    title: t('ghost.sceneResearch'),
    desc: t('ghost.sceneResearchDesc'),
    icon: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
    goal: t('ghost.sceneResearchGoal'),
  },
]

const sortedTasks = computed(() => {
  const order = { decomposing: 0, running: 1, summarizing: 2, done: 3, failed: 4, stopped: 5 } as Record<string, number>
  return [...tasks.value].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.createdAt - a.createdAt)
})

// ---- 数据加载 ----
async function loadTasks() {
  try {
    const r = await fetch('/api/ghost/tasks')
    if (r.ok) tasks.value = await r.json()
  } catch { /* ignore */ }
}

// ---- 发起任务 ----
async function startScene(s: { goal: string }) {
  await startGoal(s.goal)
}
async function startCustom() {
  if (!customGoal.value.trim()) return
  await startGoal(customGoal.value.trim())
  customGoal.value = ''
}
async function startGoal(goal: string) {
  starting.value = true
  try {
    const r = await fetch('/api/ghost/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal, mode: researchMode.value ? 'research' : 'auto' }),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = await r.json()
    // 乐观挂载任务卡
    tasks.value.unshift({
      taskId: d.taskId,
      goal,
      status: 'decomposing',
      createdAt: Date.now(),
      subtasks: [],
      ghosts: [],
      summary: '',
    })
    nMessage.success(t('ghost.started'))
  } catch (e: any) {
    nMessage.error(e?.message || t('ghost.startFailed'))
  } finally {
    starting.value = false
  }
}

async function stopTask(t: GhostTask) {
  await fetch(`/api/ghost/tasks/${t.taskId}/stop`, { method: 'POST' }).catch(() => {})
}

// ---- ws 实时推送 ----
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws/ghost`)
  ws.onopen = () => { wsConnected.value = true }
  ws.onclose = () => {
    wsConnected.value = false
    // 断线重连
    wsTimer = setTimeout(connectWs, 3000)
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'snapshot' && Array.isArray(msg.tasks)) {
        tasks.value = msg.tasks
        return
      }
      if (msg.type !== 'ghost') return
      const taskId = msg.taskId
      const idx = tasks.value.findIndex((x) => x.taskId === taskId)
      if (idx < 0) { loadTasks(); return }
      const task = tasks.value[idx]
      if (msg.event === 'task') {
        if (msg.status) task.status = msg.status
        if (msg.subtasks) task.subtasks = msg.subtasks
        if (msg.summary) task.summary = msg.summary
        if (msg.error) task.error = msg.error
        if (msg.status === 'done' || msg.status === 'failed' || msg.status === 'stopped') task.finishedAt = Date.now()
      } else if (msg.ghost) {
        const gi = task.ghosts.findIndex((g) => g.id === msg.ghostId)
        if (gi >= 0) task.ghosts[gi] = { ...task.ghosts[gi], ...msg.ghost }
        else task.ghosts.push(msg.ghost)
      }
    } catch { /* ignore */ }
  }
}

// ---- 观察者 ----
async function toggleObserver() {
  observerEnabled.value = !observerEnabled.value
  await fetch('/api/ghost/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: observerEnabled.value }),
  }).catch(() => {})
}

// ---- 文案 ----
function statusText(s: string) {
  const map: Record<string, string> = {
    decomposing: t('ghost.stDecomposing'),
    running: t('ghost.stRunning'),
    summarizing: t('ghost.stSummarizing'),
    done: t('ghost.stDone'),
    failed: t('ghost.stFailed'),
    stopped: t('ghost.stStopped'),
  }
  return map[s] || s
}
function ghostStatusText(s: string) {
  const map: Record<string, string> = {
    running: t('ghost.gRunning'),
    done: t('ghost.gDone'),
    failed: t('ghost.gFailed'),
    stopped: t('ghost.gStopped'),
  }
  return map[s] || s
}
function timeText(t: GhostTask) {
  if (t.finishedAt) return new Date(t.finishedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return new Date(t.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

onMounted(async () => {
  await loadTasks()
  connectWs()
  // 观察者状态
  try {
    const r = await fetch('/api/ghost/status')
    if (r.ok) { const d = await r.json(); if (typeof d.enabled === 'boolean') observerEnabled.value = d.enabled }
  } catch { /* ignore */ }
})
onUnmounted(() => {
  if (wsTimer) clearTimeout(wsTimer)
  ws?.close()
})
</script>

<style scoped>
.ghost-workbench {
  padding: 20px 24px;
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* 视图自身滚动：外层 .main-content 是 overflow:hidden（flex 布局要求），不设滚动则报告展开后滚不动 */
  height: 100%;
  overflow-y: auto;
}
.wb-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.wb-title { display: flex; align-items: center; gap: 10px; color: var(--text-primary); }
.wb-title h1 { font-size: 18px; font-weight: 500; margin: 0; }
.wb-sub { font-size: 12px; color: var(--text-muted); }
.wb-header-actions { display: flex; align-items: center; gap: 12px; }
.wb-observer { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); }
.wb-toggle {
  width: 34px; height: 18px; border-radius: 9px; border: none; cursor: pointer;
  background: var(--border); position: relative; transition: background .2s;
}
.wb-toggle.on { background: var(--accent); }
.wb-toggle-knob {
  position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 7px;
  background: #fff; transition: left .2s;
}
.wb-toggle.on .wb-toggle-knob { left: 18px; }

.wb-section { display: flex; flex-direction: column; gap: 8px; }
.wb-section-title { font-size: 13px; font-weight: 500; color: var(--text-secondary); display: flex; align-items: center; gap: 8px; }
.wb-live { width: 8px; height: 8px; border-radius: 4px; background: var(--text-muted); }
.wb-live.connected { background: var(--success, #4caf50); }

.scene-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.scene-card {
  background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 10px;
  padding: 14px; display: flex; flex-direction: column; gap: 4px; text-align: left;
  cursor: pointer; transition: border-color .15s;
}
.scene-card:hover { border-color: var(--accent); }
.scene-icon { color: var(--accent); margin-bottom: 4px; }
.scene-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
.scene-desc { font-size: 11px; color: var(--text-muted); line-height: 1.5; }
.scene-go { font-size: 11px; color: var(--accent); margin-top: 4px; }

.custom-task { display: flex; gap: 8px; }
.custom-task-mode { display: inline-flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; color: var(--text-2); cursor: pointer; user-select: none; }
.custom-task-mode input { accent-color: var(--accent); cursor: pointer; }
.custom-task-mode.on span { color: var(--accent); }
.custom-task-input {
  flex: 1; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-secondary); color: var(--text-primary); font-size: 13px; outline: none;
}
.custom-task-input:focus { border-color: var(--accent); }
.custom-task-btn {
  padding: 0 18px; border-radius: 8px; border: none; cursor: pointer;
  background: var(--accent); color: #fff; font-size: 13px;
}
.custom-task-btn:disabled { opacity: .5; cursor: not-allowed; }

.wb-empty { font-size: 12px; color: var(--text-muted); padding: 16px 0; text-align: center; }

.task-card {
  background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
}
.task-head { display: flex; align-items: center; gap: 10px; }
.task-name { font-size: 13px; font-weight: 500; color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-status { font-size: 11px; padding: 2px 8px; border-radius: 5px; }
.status--decomposing, .status--running, .status--summarizing { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
.status--done { background: color-mix(in srgb, var(--success, #4caf50) 14%, transparent); color: var(--success, #4caf50); }
.status--failed { background: color-mix(in srgb, var(--error) 14%, transparent); color: var(--error); }
.status--stopped { background: var(--border); color: var(--text-muted); }
.task-time { font-size: 11px; color: var(--text-muted); }
.task-stop { font-size: 11px; border: none; background: transparent; color: var(--text-muted); cursor: pointer; }
.task-stop:hover { color: var(--error); }

.task-ghosts { display: flex; flex-direction: column; gap: 6px; }
.ghost-card {
  background: var(--bg-primary); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; display: flex; flex-direction: column; gap: 5px;
}
.ghost-head { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); }
.ghost-title { font-weight: 500; color: var(--text-primary); }
.ghost-status { margin-left: auto; font-size: 11px; }
.gs--running { color: var(--accent); }
.gs--done { color: var(--success, #4caf50); }
.gs--failed { color: var(--error); }
.gs--stopped { color: var(--text-muted); }
.ghost-progress { font-size: 11px; color: var(--accent); }
.ghost-bar { height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; }
.ghost-bar-fill { height: 4px; border-radius: 2px; background: var(--accent); transition: width .3s; }
.ghost-log { display: flex; flex-direction: column; gap: 2px; }
.ghost-log-line { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono, monospace); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ghost-error { font-size: 11px; color: var(--error); }

.task-summary { border-top: 1px dashed var(--border); padding-top: 10px; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
/* "汇总结果"彩色按钮框（右下角）：accent 描边 + 淡色底，hover 实心 */
.summary-head {
  display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600;
  color: var(--accent); background: var(--accent-muted, color-mix(in srgb, var(--accent) 12%, transparent));
  border: 1px solid var(--accent); border-radius: 6px; padding: 5px 12px; cursor: pointer;
  transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
  font-family: inherit;
}
.summary-head:hover { background: var(--accent); color: #fff; }
.summary-head svg { transition: transform .2s; }
.task-summary.expanded .summary-head svg { transform: rotate(180deg); }
/* 最终报告：独立卡片框（底色/描边/圆角），内部可滚动 */
.summary-body {
  width: 100%; font-size: 12px; color: var(--text-secondary); padding: 12px 14px; line-height: 1.7;
  background: var(--bg-tertiary); border: 1px solid var(--border-color); border-radius: 8px;
  max-height: 420px; overflow-y: auto;
}
</style>
